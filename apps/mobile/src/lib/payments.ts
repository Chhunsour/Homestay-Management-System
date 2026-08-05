import { CryptoDigestAlgorithm, digest, randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import {
  PAYMENT_PROOF_BUCKET,
  PROOF_EXTENSIONS,
  PROOF_MAX_BYTES,
  duplicatesFromError,
  isProofMimeType,
  overpaymentFromError,
  paymentErrorKey,
  paymentProofPath,
  zonedTimeToUtc,
} from '@homestay/shared';
import type {
  BookingPaymentSummary,
  Currency,
  OverpaymentDetail,
  Payment,
  PaymentDuplicate,
  PaymentMethod,
  PaymentWithDetails,
  Receipt,
  TranslationKey,
} from '@homestay/shared';
import { supabase } from '@/lib/supabase';
import { dayRange, todayIn } from '@/lib/bookings';

/**
 * Payments for the app.
 *
 * Same shape as `lib/bookings.ts`: reads are scoped by `business_id` on top of
 * RLS, and every write goes through an RPC that re-checks the permission, takes
 * the per-booking lock and recomputes the balance. Nothing here trusts a number
 * the phone calculated — balances always come back from the database.
 */

const PAYMENT_SELECT =
  '*, proofs:payment_proofs(*), adjustments:payment_adjustments(*), ' +
  'booking:bookings(id, booking_number, check_in_at, check_out_at, property:properties(id, name)), ' +
  'customer:customers(id, full_name, phone)';

/** Signed URLs live ten minutes. Long enough to look, short enough to leak badly. */
const SIGNED_URL_TTL = 60 * 10;

/** PostgREST nests the property under the booking; the screens want it flat. */
function flatten(row: unknown): PaymentWithDetails {
  const record = row as PaymentWithDetails & {
    booking?: (PaymentWithDetails['booking'] & { property?: PaymentWithDetails['property'] }) | null;
  };
  return {
    ...record,
    proofs: record.proofs ?? [],
    adjustments: record.adjustments ?? [],
    property: record.booking?.property ?? null,
  };
}

/** Every payment on one booking, oldest first — the history reads as a story. */
export async function listBookingPayments(
  businessId: string,
  bookingId: string,
): Promise<PaymentWithDetails[]> {
  const { data, error } = await supabase
    .from('payments')
    .select(PAYMENT_SELECT)
    .eq('business_id', businessId)
    .eq('booking_id', bookingId)
    .order('paid_at', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map(flatten);
}

export async function getPayment(
  businessId: string,
  paymentId: string,
): Promise<PaymentWithDetails | null> {
  const { data, error } = await supabase
    .from('payments')
    .select(PAYMENT_SELECT)
    .eq('business_id', businessId)
    .eq('id', paymentId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? flatten(data) : null;
}

/**
 * What a booking owes. The database recomputes this from the payment rows on
 * every call; there is no balance column to drift.
 */
export async function getBookingPaymentSummary(
  bookingId: string,
): Promise<BookingPaymentSummary | null> {
  const { data, error } = await supabase.rpc('booking_payment_summary', {
    p_booking_id: bookingId,
  });

  if (error) throw new Error(error.message);
  return ((data ?? []) as BookingPaymentSummary[])[0] ?? null;
}

export async function listReceipts(businessId: string, bookingId: string): Promise<Receipt[]> {
  const { data, error } = await supabase
    .from('receipts')
    .select('*')
    .eq('business_id', businessId)
    .eq('booking_id', bookingId)
    .order('issued_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as Receipt[];
}

export async function getReceipt(businessId: string, receiptId: string): Promise<Receipt | null> {
  const { data, error } = await supabase
    .from('receipts')
    .select('*')
    .eq('business_id', businessId)
    .eq('id', receiptId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as Receipt) ?? null;
}

/**
 * The bucket is private, so a proof is only ever reachable through a
 * short-lived signed URL minted for a caller that storage RLS already let read
 * the object. A public URL for a payment screenshot would be a bank statement
 * on the open web.
 */
export async function signedProofUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};

  const { data, error } = await supabase.storage
    .from(PAYMENT_PROOF_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL);
  // A missing screenshot must not take the screen down.
  if (error) return {};

  const out: Record<string, string> = {};
  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl) out[entry.path] = entry.signedUrl;
  }
  return out;
}

export interface HomeMoney {
  unpaid: number;
  awaitingDeposit: number;
  balanceDue: number;
  paidToday: number;
  currency: Currency;
}

/** Money figures for the home tab: what is owed, and what came in today. */
export async function getHomeMoney(
  businessId: string,
  timeZone: string,
  currency: Currency,
): Promise<HomeMoney> {
  const today = dayRange(todayIn(timeZone), timeZone);
  const now = new Date().toISOString();

  const [totals, paidTodayRows, live] = await Promise.all([
    supabase
      .from('booking_payment_totals')
      .select('booking_id, booking_total, total_paid, refund_total')
      .eq('business_id', businessId),
    supabase
      .from('payments')
      .select('amount, payment_type, status')
      .eq('business_id', businessId)
      .gte('paid_at', today.start)
      .lt('paid_at', today.end),
    // Only bookings that have not finished are worth chasing money for.
    supabase.from('bookings').select('id').eq('business_id', businessId).gte('check_out_at', now),
  ]);

  const liveIds = new Set(((live.data ?? []) as { id: string }[]).map((row) => row.id));

  let unpaid = 0;
  let awaitingDeposit = 0;
  let balanceDue = 0;
  for (const row of (totals.data ?? []) as {
    booking_id: string;
    booking_total: number;
    total_paid: number;
    refund_total: number;
  }[]) {
    if (!liveIds.has(row.booking_id)) continue;
    const net = Number(row.total_paid) - Number(row.refund_total);
    const total = Number(row.booking_total);
    if (net <= 0) unpaid += 1;
    if (net < total / 2) awaitingDeposit += 1;
    balanceDue += Math.max(total - net, 0);
  }

  let paidToday = 0;
  for (const row of (paidTodayRows.data ?? []) as Pick<
    Payment,
    'amount' | 'payment_type' | 'status'
  >[]) {
    if (row.status === 'voided') continue;
    paidToday += row.payment_type === 'refund' ? -Number(row.amount) : Number(row.amount);
  }

  return { unpaid, awaitingDeposit, balanceDue, paidToday, currency };
}

// --- writes -----------------------------------------------------------------

export interface PaymentWriteResult {
  id: string | null;
  errorKey: TranslationKey | null;
  /** The rows that made this look like a repeat, so the screen can offer an override. */
  duplicates: PaymentDuplicate[];
  /** By how much this would exceed the booking total. */
  overpayment: OverpaymentDetail | null;
}

const OK: PaymentWriteResult = { id: null, errorKey: null, duplicates: [], overpayment: null };

function writeError(error: {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}): PaymentWriteResult {
  return {
    id: null,
    errorKey: paymentErrorKey(error),
    duplicates: duplicatesFromError(error),
    overpayment: overpaymentFromError(error),
  };
}

export interface PaymentInput {
  bookingId: string;
  amount: number;
  method: PaymentMethod;
  paymentType: Payment['payment_type'];
  /** Local `YYYY-MM-DDTHH:mm`, or blank for "right now". */
  paidAt: string;
  reference: string;
  payerName: string;
  note: string;
  duplicateOverride: boolean;
  overpaymentOverride: boolean;
  overrideReason: string;
}

export async function recordPayment(
  timeZone: string,
  input: PaymentInput,
): Promise<PaymentWriteResult> {
  const { data, error } = await supabase.rpc('record_payment', {
    p_booking_id: input.bookingId,
    p_amount: input.amount,
    p_method: input.method,
    p_payment_type: input.paymentType,
    // A blank date means "now"; the owner is typing this as the money lands.
    p_paid_at: input.paidAt
      ? zonedTimeToUtc(input.paidAt, timeZone).toISOString()
      : new Date().toISOString(),
    p_reference: input.reference || null,
    p_payer_name: input.payerName || null,
    p_note: input.note || null,
    p_duplicate_override: input.duplicateOverride,
    p_overpayment_override: input.overpaymentOverride,
    p_override_reason: input.overrideReason || null,
  });
  if (error) return writeError(error);

  const saved = (Array.isArray(data) ? data[0] : data) as { id: string } | null;
  return { ...OK, id: saved?.id ?? null };
}

export async function verifyPayment(paymentId: string): Promise<PaymentWriteResult> {
  const { error } = await supabase.rpc('verify_payment', { p_payment_id: paymentId });
  return error ? writeError(error) : OK;
}

/** The row stays; it just stops counting, and says who stopped it. */
export async function voidPayment(
  paymentId: string,
  reason: string,
): Promise<PaymentWriteResult> {
  const { error } = await supabase.rpc('void_payment', {
    p_payment_id: paymentId,
    p_reason: reason,
  });
  return error ? writeError(error) : OK;
}

export async function correctPayment(
  paymentId: string,
  amount: number,
  reason: string,
  method?: PaymentMethod,
): Promise<PaymentWriteResult> {
  const { error } = await supabase.rpc('correct_payment', {
    p_payment_id: paymentId,
    p_amount: amount,
    p_reason: reason,
    p_method: method ?? null,
    p_paid_at: null,
    p_reference: null,
    p_payer_name: null,
    p_note: null,
  });
  return error ? writeError(error) : OK;
}

/** Money going back out. Its own row, so nothing is ever edited away. */
export async function refundPayment(
  paymentId: string,
  amount: number,
  reason: string,
  method?: PaymentMethod,
): Promise<PaymentWriteResult> {
  const { error } = await supabase.rpc('refund_payment', {
    p_payment_id: paymentId,
    p_amount: amount,
    p_reason: reason,
    p_method: method ?? null,
  });
  return error ? writeError(error) : OK;
}

export async function issueReceipt(
  bookingId: string,
  paymentId: string | null,
  language: Receipt['language'],
): Promise<PaymentWriteResult> {
  const { data, error } = await supabase.rpc('issue_receipt', {
    p_booking_id: bookingId,
    p_payment_id: paymentId,
    p_language: language,
  });
  if (error) return writeError(error);

  const receipt = (Array.isArray(data) ? data[0] : data) as { id: string } | null;
  return { ...OK, id: receipt?.id ?? null };
}

// --- proofs -----------------------------------------------------------------

export interface PickedProof {
  uri: string;
  fileName: string | null;
  mimeType: string | null;
}

/**
 * A screenshot from Messenger. It goes into a private bucket under a key the
 * storage policies can parse back to a business, and the metadata row is what
 * makes it visible — an object with no row is unreachable and gets cleaned up
 * on the spot.
 */
export async function uploadProof(
  businessId: string,
  paymentId: string,
  proof: PickedProof,
): Promise<TranslationKey | null> {
  const mimeType = proof.mimeType ?? '';
  // Storage enforces both of these too; failing here gives a translated message.
  if (!isProofMimeType(mimeType)) return 'payment.proof.error.type';

  let bytes: Uint8Array;
  try {
    bytes = await new File(proof.uri).bytes();
  } catch {
    return 'payment.proof.error.upload';
  }
  if (bytes.byteLength > PROOF_MAX_BYTES) return 'payment.proof.error.size';

  const storagePath = paymentProofPath({
    businessId,
    paymentId,
    // Never the picked file name: it decides the object key, and the key is
    // what the storage policies parse.
    fileName: `${randomUUID()}.${PROOF_EXTENSIONS[mimeType]}`,
  });

  const uploaded = await supabase.storage
    .from(PAYMENT_PROOF_BUCKET)
    .upload(storagePath, bytes, { contentType: mimeType, upsert: false });
  if (uploaded.error) return 'payment.proof.error.upload';

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from('payment_proofs').insert({
    business_id: businessId,
    payment_id: paymentId,
    storage_path: storagePath,
    file_name: (proof.fileName ?? 'proof').slice(0, 255),
    mime_type: mimeType,
    size_bytes: bytes.byteLength,
    checksum: await sha256(bytes),
    uploaded_by: user?.id ?? null,
  });
  if (error) {
    // Do not leave an orphan object behind if the metadata row is rejected.
    await supabase.storage.from(PAYMENT_PROOF_BUCKET).remove([storagePath]);
    return paymentErrorKey(error);
  }

  return null;
}

/** Same screenshot forwarded twice is worth knowing about; the digest is how. */
async function sha256(bytes: Uint8Array): Promise<string> {
  // expo-crypto, not crypto.subtle: React Native has no WebCrypto.
  const hash = await digest(CryptoDigestAlgorithm.SHA256, bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
