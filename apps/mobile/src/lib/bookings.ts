import {
  BOOKING_PAGE_SIZE,
  bookingSearchFilter,
  customerSearchFilter,
  isPendingExpired,
  zonedTimeToUtc,
} from '@homestay/shared';
import type {
  BookingConflict,
  BookingFilter,
  BookingInput,
  BookingStatus,
  BookingWithDetails,
  Customer,
  Property,
  PropertyWithDetails,
  TranslationKey,
} from '@homestay/shared';
import { bookingErrorKey, conflictsFromError } from '@homestay/shared';
import { supabase } from '@/lib/supabase';

/**
 * Booking queries and writes for the app.
 *
 * Reads are scoped by `business_id` on top of RLS. Writes never touch the table:
 * they go through `save_booking`, `set_booking_status` and
 * `resolve_pending_booking`, which take the advisory lock, re-check permissions
 * and recompute the price. The client's price is only ever a preview.
 */

const BOOKING_SELECT =
  '*, status:booking_statuses(*), ' +
  'property:properties(id, name, is_active, archived_at), ' +
  'customer:customers(id, full_name, phone, normalized_phone)';

/** Midnight-to-midnight for a local day, as instants. */
export function dayRange(day: string, timeZone: string): { start: string; end: string } {
  const start = zonedTimeToUtc(`${day}T00:00`, timeZone);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}

/** `YYYY-MM-DD` for "now" in the business's zone. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

export interface BookingPage {
  bookings: BookingWithDetails[];
  hasMore: boolean;
}

export async function listBookings(
  businessId: string,
  timeZone: string,
  options: { search?: string; filter?: BookingFilter; propertyId?: string; page?: number } = {},
): Promise<BookingPage> {
  const filter = options.filter ?? 'upcoming';
  const now = new Date().toISOString();
  const today = dayRange(todayIn(timeZone), timeZone);

  let query = supabase
    .from('bookings')
    // `!inner` on the status so `expired` can filter by its code.
    .select(
      filter === 'expired'
        ? BOOKING_SELECT.replace('booking_statuses(', 'booking_statuses!inner(')
        : BOOKING_SELECT,
    )
    .eq('business_id', businessId)
    .order('check_in_at', { ascending: filter !== 'all' });

  if (options.propertyId) query = query.eq('property_id', options.propertyId);
  if (filter === 'upcoming') query = query.gte('check_out_at', now);
  if (filter === 'today') {
    query = query.lt('check_in_at', today.end).gt('check_out_at', today.start);
  }
  if (filter === 'expired') {
    query = query
      .eq('status.code', 'pending')
      .lte('pending_expires_at', now)
      .is('pending_resolved_at', null);
  }

  const search = options.search?.trim();
  if (search) {
    const orFilter = bookingSearchFilter(search, await matchingCustomerIds(businessId, search));
    if (!orFilter) return { bookings: [], hasMore: false };
    query = query.or(orFilter);
  }

  const limit = Math.max(1, options.page ?? 1) * BOOKING_PAGE_SIZE;
  const { data, error } = await query.range(0, limit);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as BookingWithDetails[];
  return { bookings: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** Guests whose name or phone matches; PostgREST cannot `or` into the embed. */
async function matchingCustomerIds(businessId: string, search: string): Promise<string[]> {
  const orFilter = customerSearchFilter(search);
  if (!orFilter) return [];

  const { data, error } = await supabase
    .from('customers')
    .select('id')
    .eq('business_id', businessId)
    .or(orFilter)
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => (row as { id: string }).id);
}

export async function getBooking(
  businessId: string,
  bookingId: string,
): Promise<BookingWithDetails | null> {
  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_SELECT)
    .eq('business_id', businessId)
    .eq('id', bookingId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as unknown as BookingWithDetails) ?? null;
}

/** Every stay overlapping `[from, to)`, for the calendar. Half-open, as always. */
export async function listCalendarBookings(
  businessId: string,
  timeZone: string,
  range: { from: string; to: string },
  propertyId?: string,
): Promise<BookingWithDetails[]> {
  let query = supabase
    .from('bookings')
    .select(BOOKING_SELECT)
    .eq('business_id', businessId)
    .lt('check_in_at', dayRange(range.to, timeZone).start)
    .gt('check_out_at', dayRange(range.from, timeZone).start)
    .order('check_in_at', { ascending: true });

  if (propertyId) query = query.eq('property_id', propertyId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as BookingWithDetails[];
}

export async function listBookingStatuses(
  businessId: string,
  includeInactive = false,
): Promise<BookingStatus[]> {
  let query = supabase
    .from('booking_statuses')
    .select('*')
    .eq('business_id', businessId)
    .order('sort_order', { ascending: true });

  if (!includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as BookingStatus[];
}

/** Bookable properties with their rates, so the form can preview a price. */
export async function listBookableProperties(businessId: string): Promise<PropertyWithDetails[]> {
  const { data, error } = await supabase
    .from('properties')
    .select('*, pricing:property_pricing(*)')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .is('archived_at', null)
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);

  // PostgREST returns a one-to-one embed as an array; flatten it here.
  return (data ?? []).map((row) => {
    const { pricing, ...property } = row as Property & { pricing: unknown };
    return {
      ...property,
      pricing: (Array.isArray(pricing) ? pricing[0] : pricing) ?? null,
    } as PropertyWithDetails;
  });
}

export async function listCustomerOptions(
  businessId: string,
  search?: string,
): Promise<Pick<Customer, 'id' | 'full_name' | 'phone'>[]> {
  let query = supabase
    .from('customers')
    .select('id, full_name, phone')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .order('full_name', { ascending: true })
    .limit(200);

  const term = search?.trim();
  if (term) {
    const orFilter = customerSearchFilter(term);
    if (orFilter) query = query.or(orFilter);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Pick<Customer, 'id' | 'full_name' | 'phone'>[];
}

export interface HomeBookings {
  today: BookingWithDetails[];
  checkIns: BookingWithDetails[];
  checkOuts: BookingWithDetails[];
  pending: BookingWithDetails[];
  expired: BookingWithDetails[];
  availableProperties: Pick<Property, 'id' | 'name'>[];
}

const UPCOMING_DAYS = 7;

/** Everything the home tab shows. No money: that is Phase 5. */
export async function getHomeBookings(businessId: string, timeZone: string): Promise<HomeBookings> {
  const today = dayRange(todayIn(timeZone), timeZone);
  const horizon = new Date(Date.parse(today.start) + UPCOMING_DAYS * 86_400_000).toISOString();

  // ponytail: one window query split in JS beats six round trips on mobile data.
  const [{ data: rows, error }, properties, expiredPage] = await Promise.all([
    supabase
      .from('bookings')
      .select(BOOKING_SELECT)
      .eq('business_id', businessId)
      .gt('check_out_at', today.start)
      .lt('check_in_at', horizon)
      .order('check_in_at', { ascending: true }),
    supabase
      .from('properties')
      .select('id, name')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .is('archived_at', null)
      .order('name', { ascending: true }),
    // Unbounded on purpose: an old expired hold must not fall out of the window.
    listBookings(businessId, timeZone, { filter: 'expired' }),
  ]);
  if (error) throw new Error(error.message);
  if (properties.error) throw new Error(properties.error.message);

  const bookings = ((rows ?? []) as unknown as BookingWithDetails[]).filter(
    (booking) => booking.status?.code !== 'cancelled',
  );
  const now = new Date();

  const occupiedToday = new Set(
    bookings
      .filter((booking) => booking.check_in_at < today.end && booking.check_out_at > today.start)
      .map((booking) => booking.property_id),
  );

  return {
    today: bookings.filter(
      (booking) => booking.check_in_at < today.end && booking.check_out_at > today.start,
    ),
    checkIns: bookings.filter((booking) => booking.check_in_at >= today.start),
    checkOuts: bookings.filter((booking) => booking.check_out_at >= today.start),
    pending: bookings.filter(
      (booking) => booking.status?.code === 'pending' && !isPendingExpired(booking, now),
    ),
    expired: expiredPage.bookings,
    availableProperties: ((properties.data ?? []) as Pick<Property, 'id' | 'name'>[]).filter(
      (property) => !occupiedToday.has(property.id),
    ),
  };
}

// --- writes -----------------------------------------------------------------

export interface BookingWriteResult {
  id: string | null;
  errorKey: TranslationKey | null;
  /** What stood in the way, so the screen can offer the override. */
  conflicts: BookingConflict[];
}

const OK: BookingWriteResult = { id: null, errorKey: null, conflicts: [] };

function writeError(error: {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}): BookingWriteResult {
  return { id: null, errorKey: bookingErrorKey(error), conflicts: conflictsFromError(error) };
}

/**
 * Create or update. `bookingId` null creates; the RPC generates the number,
 * prices the stay and refuses a clash unless the caller may override it.
 */
export async function saveBooking(
  businessId: string,
  timeZone: string,
  input: BookingInput,
  bookingId: string | null,
): Promise<BookingWriteResult> {
  let customerId = input.customerId;

  // A guest typed straight into the booking form: create them, then book. The
  // enquiry is on the phone right now — another screen loses it.
  if (!customerId) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from('customers')
      .insert({
        business_id: businessId,
        full_name: input.newCustomerName,
        phone: input.newCustomerPhone,
        created_by: user?.id ?? null,
      })
      .select('id')
      .maybeSingle();
    if (error) {
      return {
        id: null,
        errorKey: error.code === '23505' ? 'customer.duplicate.error' : 'error.generic',
        conflicts: [],
      };
    }
    customerId = (data as { id: string } | null)?.id ?? null;
    if (!customerId) return { id: null, errorKey: 'error.generic', conflicts: [] };
  }

  const { data, error } = await supabase.rpc('save_booking', {
    p_business_id: businessId,
    p_property_id: input.propertyId,
    p_customer_id: customerId,
    p_check_in: zonedTimeToUtc(input.checkInAt, timeZone).toISOString(),
    p_check_out: zonedTimeToUtc(input.checkOutAt, timeZone).toISOString(),
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

  // A function returning a table row arrives as an object, or a one-row array.
  const saved = (Array.isArray(data) ? data[0] : data) as { id: string } | null;
  return { ...OK, id: saved?.id ?? null };
}

/** Status changes, including cancel, reopen and mark completed. */
export async function setBookingStatus(
  bookingId: string,
  statusId: string,
  override?: { reason: string },
): Promise<BookingWriteResult> {
  const { error } = await supabase.rpc('set_booking_status', {
    p_booking_id: bookingId,
    p_status_id: statusId,
    p_conflict_override: Boolean(override),
    p_conflict_reason: override?.reason ?? null,
  });
  return error ? writeError(error) : OK;
}

/** Keep an expired hold alive, or cancel it and release the dates. */
export async function resolvePending(
  bookingId: string,
  action: 'keep' | 'release',
): Promise<BookingWriteResult> {
  const { error } = await supabase.rpc('resolve_pending_booking', {
    p_booking_id: bookingId,
    p_action: action,
  });
  return error ? writeError(error) : OK;
}
