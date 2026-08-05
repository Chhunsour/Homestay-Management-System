import {
  BOOKING_PAGE_SIZE,
  bookingSearchFilter,
  customerSearchFilter,
  isPendingExpired,
  zonedTimeToUtc,
} from '@homestay/shared';
import type {
  BookingFilter,
  BookingStatus,
  BookingWithDetails,
  BusinessContext,
  Customer,
  Property,
  PropertyWithDetails,
} from '@homestay/shared';
import { listProperties } from '@/lib/properties';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Read helpers for the booking and calendar screens.
 *
 * Every query is scoped by `business_id` as well as being behind RLS — the
 * policies are the boundary, the filter only keeps a mistake from looking like
 * an empty list. Writes never happen here: they all go through `save_booking`
 * and friends in `lib/actions/bookings.ts`.
 */

/** The embed every booking screen needs, aliased into `BookingWithDetails`. */
const BOOKING_SELECT =
  '*, status:booking_statuses(*), ' +
  'property:properties(id, name, is_active, archived_at), ' +
  'customer:customers(id, full_name, phone, normalized_phone)';

/** Midnight-to-midnight for a local day, as instants. */
export function dayRange(day: string, timeZone: string): { start: string; end: string } {
  const start = zonedTimeToUtc(`${day}T00:00`, timeZone);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 86_400_000).toISOString(),
  };
}

/** `YYYY-MM-DD` for "now" in the business's zone. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

export interface BookingListOptions {
  search?: string;
  filter?: BookingFilter;
  propertyId?: string;
  statusId?: string;
  from?: string;
  to?: string;
  page?: number;
}

export async function listBookings(
  context: BusinessContext,
  options: BookingListOptions = {},
): Promise<{ bookings: BookingWithDetails[]; hasMore: boolean }> {
  const supabase = await createSupabaseServerClient();
  const filter = options.filter ?? 'upcoming';
  const now = new Date().toISOString();
  const today = dayRange(todayIn(context.timezone), context.timezone);

  let query = supabase
    .from('bookings')
    // `!inner` on the status so `expired` can filter by its code.
    .select(
      filter === 'expired'
        ? BOOKING_SELECT.replace('booking_statuses(', 'booking_statuses!inner(')
        : BOOKING_SELECT,
    )
    .eq('business_id', context.business_id)
    .order('check_in_at', { ascending: filter !== 'all' });

  if (options.propertyId) query = query.eq('property_id', options.propertyId);
  if (options.statusId) query = query.eq('status_id', options.statusId);
  if (options.from)
    query = query.gte('check_out_at', dayRange(options.from, context.timezone).start);
  if (options.to) query = query.lt('check_in_at', dayRange(options.to, context.timezone).end);

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
    const orFilter = bookingSearchFilter(search, await matchingCustomerIds(context, search));
    if (!orFilter) return { bookings: [], hasMore: false };
    query = query.or(orFilter);
  }

  // Page size + 1: one row past the page is how "show more" knows to appear.
  const limit = Math.max(1, options.page ?? 1) * BOOKING_PAGE_SIZE;
  const { data, error } = await query.range(0, limit);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as BookingWithDetails[];
  return { bookings: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** Guests whose name or phone matches, so the booking list can search by them. */
async function matchingCustomerIds(context: BusinessContext, search: string): Promise<string[]> {
  const orFilter = customerSearchFilter(search);
  if (!orFilter) return [];

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('customers')
    .select('id')
    .eq('business_id', context.business_id)
    .or(orFilter)
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => (row as { id: string }).id);
}

export async function getBooking(
  context: BusinessContext,
  bookingId: string,
): Promise<BookingWithDetails | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_SELECT)
    .eq('business_id', context.business_id)
    .eq('id', bookingId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as unknown as BookingWithDetails) ?? null;
}

/** Every stay overlapping `[from, to)`, for the calendar. Half-open, as always. */
export async function listCalendarBookings(
  context: BusinessContext,
  range: { from: string; to: string },
  propertyId?: string,
): Promise<BookingWithDetails[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('bookings')
    .select(BOOKING_SELECT)
    .eq('business_id', context.business_id)
    .lt('check_in_at', dayRange(range.to, context.timezone).start)
    .gt('check_out_at', dayRange(range.from, context.timezone).start)
    .order('check_in_at', { ascending: true });

  if (propertyId) query = query.eq('property_id', propertyId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as BookingWithDetails[];
}

export async function listBookingStatuses(
  context: BusinessContext,
  includeInactive = false,
): Promise<BookingStatus[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('booking_statuses')
    .select('*')
    .eq('business_id', context.business_id)
    .order('sort_order', { ascending: true });

  if (!includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as BookingStatus[];
}

/**
 * Bookable properties with their base rate, for the form's price preview.
 * The archived ones are already inactive, so one filter covers both.
 */
export async function listBookableProperties(
  context: BusinessContext,
): Promise<PropertyWithDetails[]> {
  const properties = await listProperties(context, { filter: 'active' });
  return properties.filter((property) => !property.archived_at);
}

/** Active guests for the picker. Long lists are searched, not scrolled. */
export async function listCustomerOptions(
  context: BusinessContext,
  search?: string,
): Promise<Pick<Customer, 'id' | 'full_name' | 'phone'>[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('customers')
    .select('id, full_name, phone')
    .eq('business_id', context.business_id)
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

export interface DashboardBookings {
  today: BookingWithDetails[];
  checkIns: BookingWithDetails[];
  checkOuts: BookingWithDetails[];
  pending: BookingWithDetails[];
  /** Whatever their dates — an old expired hold must not fall out of the window. */
  expired: BookingWithDetails[];
  availableProperties: Pick<Property, 'id' | 'name'>[];
}

const UPCOMING_DAYS = 7;

/** Everything the dashboard shows. No money: that is Phase 5. */
export async function getDashboardBookings(context: BusinessContext): Promise<DashboardBookings> {
  const supabase = await createSupabaseServerClient();
  const today = dayRange(todayIn(context.timezone), context.timezone);
  const horizon = new Date(Date.parse(today.start) + UPCOMING_DAYS * 86_400_000).toISOString();

  // ponytail: one query covering today plus the next week, then split in JS.
  // Six separate round trips for six small buckets is the slower lazy option.
  const [{ data: rows, error }, properties, expired] = await Promise.all([
    supabase
      .from('bookings')
      .select(BOOKING_SELECT)
      .eq('business_id', context.business_id)
      .gt('check_out_at', today.start)
      .lt('check_in_at', horizon)
      .order('check_in_at', { ascending: true }),
    supabase
      .from('properties')
      .select('id, name')
      .eq('business_id', context.business_id)
      .eq('is_active', true)
      .is('archived_at', null)
      .order('name', { ascending: true }),
    listExpiredHolds(context),
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
    expired,
    availableProperties: ((properties.data ?? []) as Pick<Property, 'id' | 'name'>[]).filter(
      (property) => !occupiedToday.has(property.id),
    ),
  };
}

/** Expired holds, whatever their dates — the dashboard window would hide old ones. */
export async function listExpiredHolds(context: BusinessContext): Promise<BookingWithDetails[]> {
  const { bookings } = await listBookings(context, { filter: 'expired' });
  return bookings;
}
