'use server';

import { revalidatePath } from 'next/cache';
import { FunctionsHttpError } from '@supabase/supabase-js';
import {
  PAYMENT_PROOF_BUCKET,
  PROOF_EXTENSIONS,
  PROOF_MAX_BYTES,
  bookingErrorKey,
  conflictsFromError,
  duplicatesFromError,
  fieldErrors,
  isProofMimeType,
  ocrBookingSchema,
  ocrPaymentExtrasSchema,
  ocrReviewFieldsSchema,
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
import type {
  BookingConflict,
  OcrConfirmationPayload,
  OcrExtraction,
  OverpaymentDetail,
  PaymentDuplicate,
  TranslationKey,
} from '@homestay/shared';
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

// --- OCR (Phase 6B) ----------------------------------------------------------

export interface OcrActionResult {
  errorKey: string | null;
  extraction: OcrExtraction | null;
  duplicates: PaymentDuplicate[];
  possibleDuplicate: boolean;
  proofId: string | null;
}

const OCR_FAILED: OcrActionResult = {
  errorKey: 'error.generic',
  extraction: null,
  duplicates: [],
  possibleDuplicate: false,
  proofId: null,
};

/** The edge function's own error keys, mapped onto this app's translation keys. */
const OCR_ERROR_KEYS: Record<string, string> = {
  auth_required: 'error.unauthorized',
  forbidden: 'error.unauthorized',
  invalid_request: 'error.generic',
  invalid_mime_type: 'ocr.source.error.type',
  invalid_file_size: 'ocr.source.error.size',
  proof_not_found: 'ocr.error.notFound',
  rate_limited: 'ocr.error.rateLimited',
  provider_error: 'ocr.error.providerFailed',
};

/** The edge function always answers `{ error: "<key>" }` on a non-2xx response. */
async function ocrErrorKey(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = (await error.context.json()) as { error?: string };
      if (body.error) return OCR_ERROR_KEYS[body.error] ?? 'error.generic';
    } catch {
      // Fall through to the network key below.
    }
  }
  return 'error.network';
}

/**
 * Runs Phase 6A's `ocr-payment-proof` function against either an
 * already-uploaded proof or a fresh screenshot. Never trusts a business id
 * from the caller — it is always the context's own, exactly like every other
 * write in this file — and never writes anything: the function itself is
 * read-only, and so is this wrapper.
 */
export async function runOcrAction(
  input: { proofId: string } | { imageBase64: string; mimeType: string },
): Promise<OcrActionResult> {
  const context = await getBusinessContext();
  if (!context) return { ...OCR_FAILED, errorKey: 'error.unauthorized' };
  try {
    requirePermission(context, 'payments.manage');
  } catch {
    return { ...OCR_FAILED, errorKey: 'error.unauthorized' };
  }

  const supabase = await createSupabaseServerClient();
  const body =
    'proofId' in input
      ? { proofId: input.proofId }
      : {
          businessId: context.business_id,
          imageBase64: input.imageBase64,
          mimeType: input.mimeType,
        };

  const { data, error } = await supabase.functions.invoke('ocr-payment-proof', { body });
  if (error) return { ...OCR_FAILED, errorKey: await ocrErrorKey(error) };

  const result = data as {
    extraction: OcrExtraction;
    duplicates: PaymentDuplicate[];
    possibleDuplicate: boolean;
  };
  return {
    errorKey: null,
    extraction: result.extraction,
    duplicates: result.duplicates ?? [],
    possibleDuplicate: result.possibleDuplicate ?? false,
    proofId: 'proofId' in input ? input.proofId : null,
  };
}

// --- confirm: booking + payment together (Phase 6C) --------------------------

/** Maps whichever of the two inner RPCs raised — booking rule or payment rule — onto one key. */
function ocrConfirmErrorKey(error: {
  code?: string;
  message?: string;
  details?: string;
}): TranslationKey {
  if ((error.message ?? '').includes('proof_not_found')) return 'ocr.error.notFound';
  const bookingKey = bookingErrorKey(error);
  if (bookingKey !== 'error.generic') return bookingKey;
  return paymentErrorKey(error);
}

export interface ConfirmOcrPaymentExtras {
  paymentType: string;
  duplicateOverride: boolean;
  overpaymentOverride: boolean;
  overrideReason: string;
}

/** A fresh screenshot the flow never stored — attached to the payment once it exists. */
export interface OcrProofUpload {
  imageBase64: string;
  mimeType: string;
  fileName: string;
}

export interface ConfirmOcrPaymentResult {
  errorKey: TranslationKey | null;
  fieldErrors: Record<string, string>;
  conflicts: BookingConflict[];
  duplicates: PaymentDuplicate[];
  overpayment: OverpaymentDetail | null;
  bookingId: string | null;
  paymentId: string | null;
  bookingNumber: string | null;
  paymentNumber: string | null;
}

const CONFIRM_FAILED: ConfirmOcrPaymentResult = {
  errorKey: 'error.generic',
  fieldErrors: {},
  conflicts: [],
  duplicates: [],
  overpayment: null,
  bookingId: null,
  paymentId: null,
  bookingNumber: null,
  paymentNumber: null,
};

/**
 * The one write behind "Confirm and save" on the OCR review flow. Everything
 * that decides whether this is allowed — the permission, the advisory lock,
 * the conflict scan, the price rule, the duplicate and overpayment checks —
 * happens inside `record_ocr_payment()`; this action only shapes the request
 * and the response. Attaching a freshly-picked screenshot is a second,
 * best-effort step after the RPC succeeds, the same order Phase 5's own
 * record-then-attach flow already uses.
 */
export async function confirmOcrPaymentAction(
  payload: OcrConfirmationPayload,
  extra: ConfirmOcrPaymentExtras,
  proofUpload: OcrProofUpload | null = null,
): Promise<ConfirmOcrPaymentResult> {
  const context = await getBusinessContext();
  if (!context) return { ...CONFIRM_FAILED, errorKey: 'error.unauthorized' };
  try {
    requirePermission(context, 'payments.manage');
  } catch {
    return { ...CONFIRM_FAILED, errorKey: 'error.unauthorized' };
  }

  const parsedFields = ocrReviewFieldsSchema.safeParse(payload.values);
  if (!parsedFields.success) {
    return { ...CONFIRM_FAILED, errorKey: 'error.generic', fieldErrors: fieldErrors(parsedFields.error) };
  }

  const bookingInput =
    payload.booking.type === 'existing'
      ? { mode: 'existing' as const, bookingId: payload.booking.bookingId }
      : {
          mode: 'new' as const,
          propertyId: payload.booking.propertyId,
          checkInAt: payload.booking.checkInAt,
          checkOutAt: payload.booking.checkOutAt,
          finalPrice: payload.booking.finalPrice === null ? '' : String(payload.booking.finalPrice),
          priceOverrideReason: payload.booking.priceOverrideReason,
          conflictOverride: payload.booking.conflictOverride,
          conflictOverrideReason: payload.booking.conflictOverrideReason,
          note: payload.booking.note,
        };
  const parsedBooking = ocrBookingSchema.safeParse(bookingInput);
  if (!parsedBooking.success) {
    return { ...CONFIRM_FAILED, errorKey: 'error.generic', fieldErrors: fieldErrors(parsedBooking.error) };
  }

  const parsedExtras = ocrPaymentExtrasSchema.safeParse(extra);
  if (!parsedExtras.success) {
    return { ...CONFIRM_FAILED, errorKey: 'error.generic', fieldErrors: fieldErrors(parsedExtras.error) };
  }

  const fields = parsedFields.data;
  const booking = parsedBooking.data;
  const extras = parsedExtras.data;

  const paidAtLocal = `${fields.paymentDate}T${fields.paymentTime ?? '00:00'}`;
  const paidAt = zonedTimeToUtc(paidAtLocal, context.timezone).toISOString();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('record_ocr_payment', {
    p_business_id: context.business_id,
    p_amount: fields.amount,
    p_method: fields.method,
    ...(booking.mode === 'existing'
      ? { p_booking_id: booking.bookingId }
      : {
          p_property_id: booking.propertyId,
          p_customer_id:
            payload.customer.type === 'existing' ? payload.customer.customerId : null,
          p_check_in: zonedTimeToUtc(booking.checkInAt, context.timezone).toISOString(),
          p_check_out: zonedTimeToUtc(booking.checkOutAt, context.timezone).toISOString(),
          p_final_price: booking.finalPrice,
          p_price_reason: booking.priceOverrideReason,
          p_conflict_override: booking.conflictOverride,
          p_conflict_reason: booking.conflictOverrideReason,
          p_booking_note: booking.note,
        }),
    p_payment_type: extras.paymentType,
    p_paid_at: paidAt,
    p_reference: fields.reference,
    p_payer_name: fields.payerName,
    p_duplicate_override: extras.duplicateOverride,
    p_overpayment_override: extras.overpaymentOverride,
    p_override_reason: extras.overrideReason,
    p_proof_id: payload.proofId,
    p_provider: payload.extraction ? 'claude-opus-5' : null,
    p_extraction: payload.extraction,
    p_original_values: payload.values,
    p_corrected_values: fields,
    p_edited_fields: payload.edited,
    p_manual_entry: !payload.extraction,
  });

  if (error) {
    return {
      ...CONFIRM_FAILED,
      errorKey: ocrConfirmErrorKey(error),
      conflicts: conflictsFromError(error),
      duplicates: duplicatesFromError(error),
      overpayment: overpaymentFromError(error),
    };
  }

  const result = data as {
    booking_id: string;
    booking_number: string;
    payment_id: string;
    payment_number: string;
  };

  if (proofUpload) {
    await attachOcrProof(context.business_id, result.payment_id, proofUpload);
  }

  revalidatePath('/payments');
  revalidatePath('/bookings');
  revalidatePath('/calendar');
  revalidatePath('/dashboard');
  revalidatePath(`/bookings/${result.booking_id}`);
  revalidatePath(`/payments/${result.payment_id}`);

  return {
    ...CONFIRM_FAILED,
    errorKey: null,
    bookingId: result.booking_id,
    bookingNumber: result.booking_number,
    paymentId: result.payment_id,
    paymentNumber: result.payment_number,
  };
}

/** Best-effort: the payment is already saved either way, this only attaches its evidence. */
async function attachOcrProof(
  businessId: string,
  paymentId: string,
  upload: OcrProofUpload,
): Promise<void> {
  if (!isProofMimeType(upload.mimeType)) return;

  const bytes = Buffer.from(upload.imageBase64, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > PROOF_MAX_BYTES) return;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const storagePath = paymentProofPath({
    businessId,
    paymentId,
    fileName: `${crypto.randomUUID()}.${PROOF_EXTENSIONS[upload.mimeType]}`,
  });

  const uploaded = await supabase.storage
    .from(PAYMENT_PROOF_BUCKET)
    .upload(storagePath, bytes, { contentType: upload.mimeType, upsert: false });
  if (uploaded.error) return;

  const checksum = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  )
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  const { error } = await supabase.from('payment_proofs').insert({
    business_id: businessId,
    payment_id: paymentId,
    storage_path: storagePath,
    file_name: upload.fileName.slice(0, 255),
    mime_type: upload.mimeType,
    size_bytes: bytes.byteLength,
    checksum,
    uploaded_by: user?.id ?? null,
  });
  if (error) {
    await supabase.storage.from(PAYMENT_PROOF_BUCKET).remove([storagePath]);
  }
}
