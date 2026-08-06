'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  bookingErrorKey,
  bookingSchema,
  bookingStatusSchema,
  conflictsFromError,
  fieldErrors,
  pendingResolutionSchema,
  zonedTimeToUtc,
} from '@homestay/shared';
import type { BookingConflict } from '@homestay/shared';
import { getBusinessContext, requirePermission } from '@/lib/business';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { failure, success, type ActionState } from '@/lib/actions/state';
import { searchOcrBookingCandidates, type OcrBookingCandidate } from '@/lib/payments';

/**
 * Server Actions for bookings.
 *
 * Every write goes through `save_booking`, `set_booking_status` or
 * `resolve_pending_booking`. Those RPCs take the advisory lock, re-check the
 * permissions and recompute the price; the checks here only turn a rejection
 * into a translated message. The business id is re-read from the database, never
 * taken from the form.
 */

export interface BookingActionState extends ActionState {
  /** What stood in the way, so the form can offer the override. */
  conflicts?: BookingConflict[];
}

function readBooking(formData: FormData) {
  return {
    propertyId: formData.get('propertyId'),
    customerId: formData.get('customerId'),
    newCustomerName: formData.get('newCustomerName'),
    newCustomerPhone: formData.get('newCustomerPhone'),
    checkInAt: formData.get('checkInAt'),
    checkOutAt: formData.get('checkOutAt'),
    statusId: formData.get('statusId'),
    source: formData.get('source') || 'other',
    note: formData.get('note'),
    internalNote: formData.get('internalNote'),
    finalPrice: formData.get('finalPrice'),
    priceOverrideReason: formData.get('priceOverrideReason'),
    conflictOverride: formData.get('conflictOverride'),
    conflictOverrideReason: formData.get('conflictOverrideReason'),
  };
}

function writeError(error: {
  code?: string;
  message?: string;
  details?: string;
}): BookingActionState {
  const conflicts = conflictsFromError(error);
  return { ...failure(bookingErrorKey(error)), ...(conflicts.length ? { conflicts } : {}) };
}

export async function saveBookingAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'bookings.manage');

  const parsed = bookingSchema.safeParse(readBooking(formData));
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));
  const input = parsed.data;

  const supabase = await createSupabaseServerClient();
  const bookingId = String(formData.get('bookingId') ?? '') || null;

  // A guest typed straight into the booking form: create them, then book. The
  // enquiry is on the phone right now — sending staff to another screen loses it.
  let customerId = input.customerId;
  if (!customerId) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from('customers')
      .insert({
        business_id: context.business_id,
        full_name: input.newCustomerName,
        phone: input.newCustomerPhone,
        created_by: user?.id ?? null,
      })
      .select('id')
      .maybeSingle();
    if (error) {
      if (error.code === '23505')
        return failure('customer.duplicate.error', {
          newCustomerPhone: 'customer.duplicate.error',
        });
      return failure('error.generic');
    }
    customerId = (data as { id: string } | null)?.id ?? null;
    if (!customerId) return failure('error.generic');
  }

  const { data, error } = await supabase.rpc('save_booking', {
    p_business_id: context.business_id,
    p_property_id: input.propertyId,
    p_customer_id: customerId,
    p_check_in: zonedTimeToUtc(input.checkInAt, context.timezone).toISOString(),
    p_check_out: zonedTimeToUtc(input.checkOutAt, context.timezone).toISOString(),
    p_booking_id: bookingId,
    p_status_id: input.statusId,
    p_source: input.source,
    p_note: input.note,
    p_internal_note: input.internalNote,
    p_final_price: input.finalPrice,
    p_price_reason: input.priceOverrideReason,
    p_conflict_override: input.conflictOverride,
    p_conflict_reason: input.conflictOverrideReason,
  });
  if (error) return writeError(error);

  // A function returning a table row arrives as an object, or as a one-row array.
  const saved = (Array.isArray(data) ? data[0] : data) as { id: string } | null;
  revalidatePath('/bookings');
  revalidatePath('/calendar');
  revalidatePath('/dashboard');
  redirect(saved ? `/bookings/${saved.id}` : '/bookings');
}

/**
 * Status changes, including cancel, reopen and mark completed. The RPC decides
 * whether the caller may do it and whether the dates are still free.
 */
export async function setBookingStatusAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'bookings.manage');

  const bookingId = String(formData.get('bookingId') ?? '');
  const statusId = String(formData.get('statusId') ?? '');

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('set_booking_status', {
    p_booking_id: bookingId,
    p_status_id: statusId,
    p_conflict_override: formData.get('conflictOverride') === 'on',
    p_conflict_reason: String(formData.get('conflictOverrideReason') ?? '') || null,
  });
  if (error) return writeError(error);

  revalidatePath('/bookings');
  revalidatePath(`/bookings/${bookingId}`);
  revalidatePath('/calendar');
  revalidatePath('/dashboard');
  return success('booking.updated');
}

/** Keep an expired hold alive, or cancel it and release the dates. */
export async function resolvePendingAction(formData: FormData): Promise<void> {
  const context = await getBusinessContext();
  if (!context) return;
  requirePermission(context, 'bookings.pending.resolve');

  const parsed = pendingResolutionSchema.safeParse({
    bookingId: formData.get('bookingId'),
    action: formData.get('action'),
  });
  if (!parsed.success) return;

  const supabase = await createSupabaseServerClient();
  await supabase.rpc('resolve_pending_booking', {
    p_booking_id: parsed.data.bookingId,
    p_action: parsed.data.action,
  });

  revalidatePath('/bookings');
  revalidatePath(`/bookings/${parsed.data.bookingId}`);
  revalidatePath('/calendar');
  revalidatePath('/dashboard');
}

/**
 * Owner-only status customisation. `code` decides system behaviour and is not
 * editable on the seeded rows — a trigger enforces that, this only hides it.
 */
export async function saveBookingStatusAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'bookings.statuses.manage');

  const parsed = bookingStatusSchema.safeParse({
    name: formData.get('name'),
    code: formData.get('code'),
    color: formData.get('color'),
    sortOrder: formData.get('sortOrder'),
    isActive: formData.get('isActive'),
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const statusId = String(formData.get('statusId') ?? '');

  const { error } = statusId
    ? await supabase
        .from('booking_statuses')
        // `code` and `is_system` are left alone: changing a built-in status's
        // behaviour would silently rewrite what every rule means.
        .update({
          name: parsed.data.name,
          color: parsed.data.color,
          sort_order: parsed.data.sortOrder,
          is_active: parsed.data.isActive,
        })
        .eq('id', statusId)
        .eq('business_id', context.business_id)
    : await supabase.from('booking_statuses').insert({
        business_id: context.business_id,
        name: parsed.data.name,
        code: parsed.data.code,
        color: parsed.data.color,
        sort_order: parsed.data.sortOrder,
        is_active: parsed.data.isActive,
        is_system: false,
      });

  if (error) {
    if (error.code === '23505')
      return failure('status.error.duplicateName', { name: 'status.error.duplicateName' });
    if (error.code === '42501' || error.message.includes('system'))
      return failure('status.error.system');
    return failure('error.generic');
  }

  revalidatePath('/bookings/statuses');
  revalidatePath('/bookings');
  return success('status.saved');
}

// --- OCR booking step (Phase 6C) ---------------------------------------------

/**
 * Bookings the OCR review flow's "existing booking" search can attach a
 * payment to. Same read as the plain booking list, filtered down to what is
 * still owed and not cancelled — see `searchOcrBookingCandidates`.
 */
export async function searchOcrBookingsAction(input: {
  search?: string;
  propertyId?: string;
}): Promise<OcrBookingCandidate[]> {
  const context = await getBusinessContext();
  if (!context) return [];
  try {
    requirePermission(context, 'bookings.manage');
  } catch {
    return [];
  }
  return searchOcrBookingCandidates(context, input);
}

export interface OcrAvailabilityResult {
  available: boolean;
  conflicts: BookingConflict[];
  errorKey: string | null;
}

/**
 * A live look at whether a new booking's dates are free, before the reviewer
 * commits to them. `record_ocr_payment()` re-checks this itself immediately
 * before saving — this call is only what the screen shows while typing.
 */
export async function checkOcrAvailabilityAction(input: {
  propertyId: string;
  checkInAt: string;
  checkOutAt: string;
}): Promise<OcrAvailabilityResult> {
  const context = await getBusinessContext();
  if (!context) return { available: false, conflicts: [], errorKey: 'error.unauthorized' };
  try {
    requirePermission(context, 'bookings.manage');
  } catch {
    return { available: false, conflicts: [], errorKey: 'error.unauthorized' };
  }
  if (!input.checkInAt || !input.checkOutAt || input.checkOutAt <= input.checkInAt) {
    return { available: false, conflicts: [], errorKey: null };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('check_booking_availability', {
    p_business_id: context.business_id,
    p_property_id: input.propertyId,
    p_check_in: zonedTimeToUtc(input.checkInAt, context.timezone).toISOString(),
    p_check_out: zonedTimeToUtc(input.checkOutAt, context.timezone).toISOString(),
  });
  if (error) return { available: false, conflicts: [], errorKey: bookingErrorKey(error) };

  const conflicts = (Array.isArray(data) ? data : (data ?? [])) as BookingConflict[];
  return { available: conflicts.length === 0, conflicts, errorKey: null };
}
