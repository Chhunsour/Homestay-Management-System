'use server';

import { revalidatePath } from 'next/cache';
import {
  PAYMENT_PROOF_BUCKET,
  PROOF_EXTENSIONS,
  PROOF_MAX_BYTES,
  duplicatesFromError,
  fieldErrors,
  isProofMimeType,
  overpaymentFromError,
  paymentCorrectionSchema,
  paymentErrorKey,
  paymentProofPath,
  paymentRefundSchema,
  paymentSchema,
  paymentVoidSchema,
  receiptSchema,
  zonedTimeToUtc,
} from '@homestay/shared';
import type { OverpaymentDetail, PaymentDuplicate } from '@homestay/shared';
import { getBusinessContext, requirePermission } from '@/lib/business';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { failure, success, type ActionState } from '@/lib/actions/state';

/**
 * Server Actions for payments.
 *
 * Every write goes through an RPC that re-checks the permission, takes the
 * per-booking advisory lock and recomputes the balance. The checks here are for
 * the message, not for the safety: a caller who skipped this file entirely still
 * cannot record a payment they are not allowed to record. The business id is
 * always re-read from the session, never taken from the form.
 */

export interface PaymentActionState extends ActionState {
  /** The rows that made this look like a repeat, so the form can offer an override. */
  duplicates?: PaymentDuplicate[];
  /** By how much this would exceed the booking total. */
  overpayment?: OverpaymentDetail;
  /** Set on success, so the form can attach a proof to what it just recorded. */
  paymentId?: string;
  receiptId?: string;
}

function writeError(error: {
  code?: string;
  message?: string;
  details?: string;
}): PaymentActionState {
  const duplicates = duplicatesFromError(error);
  const overpayment = overpaymentFromError(error);
  return {
    ...failure(paymentErrorKey(error)),
    ...(duplicates.length ? { duplicates } : {}),
    ...(overpayment ? { overpayment } : {}),
  };
}

/** Every screen that shows money about this booking. */
function revalidateBooking(bookingId: string | null): void {
  revalidatePath('/payments');
  revalidatePath('/bookings');
  revalidatePath('/dashboard');
  if (bookingId) revalidatePath(`/bookings/${bookingId}`);
}

export async function recordPaymentAction(
  _prev: PaymentActionState,
  formData: FormData,
): Promise<PaymentActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'payments.manage');

  const parsed = paymentSchema.safeParse({
    bookingId: formData.get('bookingId'),
    amount: formData.get('amount'),
    method: formData.get('method'),
    paymentType: formData.get('paymentType') || 'deposit',
    paidAt: formData.get('paidAt'),
    reference: formData.get('reference'),
    payerName: formData.get('payerName'),
    note: formData.get('note'),
    duplicateOverride: formData.get('duplicateOverride'),
    overpaymentOverride: formData.get('overpaymentOverride'),
    overrideReason: formData.get('overrideReason'),
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));
  const input = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('record_payment', {
    p_booking_id: input.bookingId,
    p_amount: input.amount,
    p_method: input.method,
    p_payment_type: input.paymentType,
    // A blank date means "now"; the owner is typing this as the money lands.
    p_paid_at: input.paidAt
      ? zonedTimeToUtc(input.paidAt, context.timezone).toISOString()
      : new Date().toISOString(),
    p_reference: input.reference,
    p_payer_name: input.payerName,
    p_note: input.note,
    p_duplicate_override: input.duplicateOverride,
    p_overpayment_override: input.overpaymentOverride,
    p_override_reason: input.overrideReason,
  });
  if (error) return writeError(error);

  const saved = (Array.isArray(data) ? data[0] : data) as { id: string } | null;
  revalidateBooking(input.bookingId);
  if (saved) revalidatePath(`/payments/${saved.id}`);
  // The id goes back so the form can attach a proof to the payment it just made.
  return { ...success('payment.recorded'), ...(saved ? { paymentId: saved.id } : {}) };
}

export async function verifyPaymentAction(
  _prev: PaymentActionState,
  formData: FormData,
): Promise<PaymentActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'payments.verify');

  const paymentId = String(formData.get('paymentId') ?? '');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('verify_payment', { p_payment_id: paymentId });
  if (error) return writeError(error);

  revalidatePath(`/payments/${paymentId}`);
  revalidateBooking(String(formData.get('bookingId') ?? '') || null);
  return success('payment.verify.done');
}

/** Owner only. The row stays; it just stops counting, and says who stopped it. */
export async function voidPaymentAction(
  _prev: PaymentActionState,
  formData: FormData,
): Promise<PaymentActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'payments.void');

  const parsed = paymentVoidSchema.safeParse({
    paymentId: formData.get('paymentId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('void_payment', {
    p_payment_id: parsed.data.paymentId,
    p_reason: parsed.data.reason,
  });
  if (error) return writeError(error);

  revalidatePath(`/payments/${parsed.data.paymentId}`);
  revalidateBooking(String(formData.get('bookingId') ?? '') || null);
  return success('payment.void.done');
}

export async function correctPaymentAction(
  _prev: PaymentActionState,
  formData: FormData,
): Promise<PaymentActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'payments.correct');

  const parsed = paymentCorrectionSchema.safeParse({
    paymentId: formData.get('paymentId'),
    amount: formData.get('amount'),
    reason: formData.get('reason'),
    method: formData.get('method') || undefined,
    paidAt: formData.get('paidAt'),
    reference: formData.get('reference'),
    payerName: formData.get('payerName'),
    note: formData.get('note'),
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));
  const input = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('correct_payment', {
    p_payment_id: input.paymentId,
    p_amount: input.amount,
    p_reason: input.reason,
    p_method: input.method ?? null,
    p_paid_at: input.paidAt ? zonedTimeToUtc(input.paidAt, context.timezone).toISOString() : null,
    p_reference: input.reference,
    p_payer_name: input.payerName,
    p_note: input.note,
  });
  if (error) return writeError(error);

  revalidatePath(`/payments/${input.paymentId}`);
  revalidateBooking(String(formData.get('bookingId') ?? '') || null);
  return success('payment.correct.done');
}

/** Money going back out. Its own row, so nothing is ever edited away. */
export async function refundPaymentAction(
  _prev: PaymentActionState,
  formData: FormData,
): Promise<PaymentActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'payments.refund');

  const parsed = paymentRefundSchema.safeParse({
    paymentId: formData.get('paymentId'),
    amount: formData.get('amount'),
    reason: formData.get('reason'),
    method: formData.get('method') || undefined,
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));
  const input = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('refund_payment', {
    p_payment_id: input.paymentId,
    p_amount: input.amount,
    p_reason: input.reason,
    p_method: input.method ?? null,
  });
  if (error) return writeError(error);

  revalidatePath(`/payments/${input.paymentId}`);
  revalidateBooking(String(formData.get('bookingId') ?? '') || null);
  return success('payment.refund.done');
}

export async function issueReceiptAction(
  _prev: PaymentActionState,
  formData: FormData,
): Promise<PaymentActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'receipts.manage');

  const parsed = receiptSchema.safeParse({
    bookingId: formData.get('bookingId'),
    paymentId: formData.get('paymentId'),
    language: formData.get('language') || 'en',
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('issue_receipt', {
    p_booking_id: parsed.data.bookingId,
    p_payment_id: parsed.data.paymentId,
    p_language: parsed.data.language,
  });
  if (error) return writeError(error);

  const receipt = (Array.isArray(data) ? data[0] : data) as { id: string } | null;
  revalidateBooking(parsed.data.bookingId);
  return { ...success('receipt.issued'), ...(receipt ? { receiptId: receipt.id } : {}) };
}

// --- proofs -----------------------------------------------------------------

/**
 * A screenshot from Messenger. It goes into a private bucket under a key the
 * storage policies can parse back to a business, and the metadata row is what
 * makes it visible — an object with no row is unreachable and gets cleaned up
 * on the spot.
 */
export async function uploadProofAction(
  _prev: PaymentActionState,
  formData: FormData,
): Promise<PaymentActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'payments.manage');

  const paymentId = String(formData.get('paymentId') ?? '');
  const file = formData.get('file');
  if (!paymentId || !(file instanceof File) || file.size === 0) return failure('error.generic');
  // Storage enforces both of these too; failing here gives a translated message.
  if (!isProofMimeType(file.type)) return failure('payment.proof.error.type');
  if (file.size > PROOF_MAX_BYTES) return failure('payment.proof.error.size');

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const storagePath = paymentProofPath({
    businessId: context.business_id,
    paymentId,
    // Never the user's file name: it decides the object key, and the key is
    // what the storage policies parse.
    fileName: `${crypto.randomUUID()}.${PROOF_EXTENSIONS[file.type]}`,
  });

  const checksum = await sha256(file);

  const uploaded = await supabase.storage
    .from(PAYMENT_PROOF_BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploaded.error) return failure('payment.proof.error.upload');

  const { error } = await supabase.from('payment_proofs').insert({
    business_id: context.business_id,
    payment_id: paymentId,
    storage_path: storagePath,
    file_name: file.name.slice(0, 255),
    mime_type: file.type,
    size_bytes: file.size,
    checksum,
    uploaded_by: user?.id ?? null,
  });
  if (error) {
    // Do not leave an orphan object behind if the metadata row is rejected.
    await supabase.storage.from(PAYMENT_PROOF_BUCKET).remove([storagePath]);
    return writeError(error);
  }

  revalidatePath(`/payments/${paymentId}`);
  revalidateBooking(String(formData.get('bookingId') ?? '') || null);
  return success('payment.proof.uploaded');
}

/** Same screenshot forwarded twice is worth knowing about; the digest is how. */
async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Signed URLs for one payment's proofs, minted per request and short-lived. */
export async function proofUrlAction(storagePath: string): Promise<string | null> {
  const context = await getBusinessContext();
  if (!context) return null;
  // Storage RLS decides; this only avoids a pointless round trip.
  if (!storagePath.startsWith(`businesses/${context.business_id}/payments/`)) return null;

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.storage
    .from(PAYMENT_PROOF_BUCKET)
    .createSignedUrl(storagePath, 60 * 10);
  return data?.signedUrl ?? null;
}
