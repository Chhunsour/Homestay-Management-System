import { BLOCKING_STATUS_CODES, DEFAULT_BOOKING_STATUSES, WEEKEND_DAYS } from './constants.ts';
import type { BookingStatusCode, Currency } from './constants.ts';
import { utcToZonedInput } from './availability.ts';
import type { BookingOccupancy } from './availability.ts';
import type { Booking, BookingStatus, BookingWithDetails, PropertyPricing } from './types.ts';
import type { Translator } from './i18n/index.ts';
import type { TranslationKey } from './i18n/en.ts';

/**
 * Booking pricing and state helpers. Pure, like `availability.ts`: rows in,
 * numbers out. Both apps price a booking through `priceBooking()` and the
 * database re-computes the same total in `booking_calculated_price()` — the
 * client's number is a preview, the server's is what gets stored.
 */

// --- days and rates ---------------------------------------------------------

/** `YYYY-MM-DD` for an instant, in the business's own time zone. */
export function localDate(instant: Date | string, timeZone: string): string {
  return utcToZonedInput(instant, timeZone).slice(0, 10);
}

/** Friday, Saturday or Sunday for a plain `YYYY-MM-DD`, with no zone maths. */
export function isWeekendDate(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (WEEKEND_DAYS as readonly number[]).includes(day);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The calendar days a stay is charged for, as local `YYYY-MM-DD`.
 *
 * Charged per night: arriving Monday and leaving Wednesday is Monday and
 * Tuesday. A same-day stay (check in and out on one date) is charged as one
 * day, which is how day-use bookings are quoted here.
 */
export function bookingDays(
  checkInAt: Date | string,
  checkOutAt: Date | string,
  timeZone: string,
): string[] {
  const first = localDate(checkInAt, timeZone);
  const last = localDate(checkOutAt, timeZone);
  if (!first || !last) return [];

  const nights = Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000);
  if (Number.isNaN(nights) || nights < 0) return [];

  return Array.from({ length: Math.max(1, nights) }, (_unused, index) => addDays(first, index));
}

export interface BookingDayRate {
  date: string;
  weekend: boolean;
  rate: number;
}

export interface BookingPrice {
  days: BookingDayRate[];
  weekdayCount: number;
  weekendCount: number;
  total: number;
  currency: Currency;
}

/**
 * Weekday rate Monday–Thursday, weekend rate Friday–Sunday, one line per day.
 *
 * `numeric` reaches JS as a number through PostgREST but as a string through
 * some clients, so both prices go through `Number()`.
 */
export function priceBooking(
  pricing: {
    weekday_price: PropertyPricing['weekday_price'] | string;
    weekend_price: PropertyPricing['weekend_price'] | string;
    currency: Currency;
  },
  checkInAt: Date | string,
  checkOutAt: Date | string,
  timeZone: string,
): BookingPrice {
  const weekday = Number(pricing.weekday_price);
  const weekend = Number(pricing.weekend_price);

  const days = bookingDays(checkInAt, checkOutAt, timeZone).map((date) => {
    const isWeekend = isWeekendDate(date);
    return { date, weekend: isWeekend, rate: isWeekend ? weekend : weekday };
  });

  const total = days.reduce((sum, day) => sum + day.rate, 0);

  return {
    days,
    weekdayCount: days.filter((day) => !day.weekend).length,
    weekendCount: days.filter((day) => day.weekend).length,
    // Money: two decimals, and no float dust from summing rates like 32.55.
    total: Math.round(total * 100) / 100,
    currency: pricing.currency,
  };
}

/** What is actually owed: the override when there is one, otherwise the maths. */
export function finalPrice(booking: {
  calculated_price: number | string;
  /** Nullable on the way in from a form; the column itself is always set. */
  final_price: number | string | null;
}): number {
  return Number(booking.final_price ?? booking.calculated_price);
}

// --- statuses ---------------------------------------------------------------

export function blocksDatesStatus(status: Pick<BookingStatus, 'code'> | null | undefined): boolean {
  return !!status && (BLOCKING_STATUS_CODES as readonly string[]).includes(status.code);
}

/** The occupancy rows `checkAvailability` wants, out of joined booking rows. */
export function toOccupancy(bookings: readonly BookingWithDetails[]): BookingOccupancy[] {
  return bookings.map((booking) => ({
    id: booking.id,
    business_id: booking.business_id,
    property_id: booking.property_id,
    check_in_at: booking.check_in_at,
    check_out_at: booking.check_out_at,
    // An overridden booking still holds its dates for everybody else.
    blocks: blocksDatesStatus(booking.status),
    booking_number: booking.booking_number,
  }));
}

const DEFAULT_STATUS_NAMES = new Set(DEFAULT_BOOKING_STATUSES.map((status) => status.name));

/**
 * Display name for a status. Seeded statuses are translated by code so Khmer
 * users do not read "Pending"; once an owner renames one, their wording wins.
 *
 * ponytail: comparing against the seeded English name beats adding a
 * `name_km` column — rename the status to translate it.
 */
export function statusLabel(
  status: Pick<BookingStatus, 'name' | 'code' | 'is_system'>,
  t: Translator,
): string {
  if (status.is_system && DEFAULT_STATUS_NAMES.has(status.name)) {
    return t(`booking.status.${status.code}` as TranslationKey);
  }
  return status.name;
}

export function findStatusByCode(
  statuses: readonly BookingStatus[],
  code: BookingStatusCode,
): BookingStatus | null {
  return (
    statuses.find((status) => status.code === code && status.is_system) ??
    statuses.find((status) => status.code === code) ??
    null
  );
}

// --- pending expiry ---------------------------------------------------------

/**
 * A pending booking whose hold has run out and that nobody has ruled on yet.
 * The dates stay held — releasing them is an explicit decision, never a
 * side effect of time passing.
 */
export function isPendingExpired(
  booking: Pick<Booking, 'pending_expires_at' | 'pending_resolved_at'> & {
    status?: Pick<BookingStatus, 'code'> | null;
  },
  now: Date = new Date(),
): boolean {
  if (booking.status && booking.status.code !== 'pending') return false;
  if (!booking.pending_expires_at || booking.pending_resolved_at) return false;
  return Date.parse(booking.pending_expires_at) <= now.getTime();
}

/** Minutes left on the hold; negative once it has lapsed. */
export function pendingMinutesLeft(
  booking: Pick<Booking, 'pending_expires_at'>,
  now: Date = new Date(),
): number | null {
  if (!booking.pending_expires_at) return null;
  return Math.round((Date.parse(booking.pending_expires_at) - now.getTime()) / 60_000);
}

// --- calendar ---------------------------------------------------------------

/** Monday = 0, Sunday = 6, so a Monday-first grid needs no special-casing. */
function mondayIndex(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** `YYYY-MM` shifted by whole months, e.g. `addMonths('2026-01', -1)`. */
export function addMonths(month: string, delta: number): string {
  const [year = 0, index = 1] = month.split('-').map(Number);
  const total = year * 12 + (index - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Whole weeks covering a `YYYY-MM`, Monday first: what a month grid draws. */
export function monthGrid(month: string): string[] {
  const first = `${month}-01`;
  const start = addDays(first, -mondayIndex(first));
  const daysInMonth = new Date(Date.parse(addMonths(month, 1) + '-01') - 1).getUTCDate();
  const cells = Math.ceil((mondayIndex(first) + daysInMonth) / 7) * 7;
  return Array.from({ length: cells }, (_unused, index) => addDays(start, index));
}

/** The Monday-to-Sunday week containing `date`. */
export function weekGrid(date: string): string[] {
  const monday = addDays(date, -mondayIndex(date));
  return Array.from({ length: 7 }, (_unused, index) => addDays(monday, index));
}

/** Does this stay occupy that local day? Half-open, so a checkout day is free. */
export function coversDate(
  booking: Pick<Booking, 'check_in_at' | 'check_out_at'>,
  date: string,
  timeZone: string,
): boolean {
  const first = localDate(booking.check_in_at, timeZone);
  const last = localDate(booking.check_out_at, timeZone);
  // A same-day stay covers the one date it happens on.
  return date >= first && (date < last || (first === last && date === first));
}

// --- search -----------------------------------------------------------------

/**
 * PostgREST `or=` filter for the booking list.
 *
 * ponytail: guest name and phone live on another table, and PostgREST cannot
 * `or` across an embedded resource. Callers resolve matching customers first
 * (with `customerSearchFilter`) and pass their ids in. Two round trips beats a
 * database view that would have to be kept in step with the search columns.
 */
export function bookingSearchFilter(term: string, customerIds: readonly string[]): string | null {
  const safe = term.replace(/[%,()*]/g, ' ').trim();
  if (!safe && customerIds.length === 0) return null;

  const parts = safe ? [`booking_number.ilike.%${safe}%`] : [];
  if (customerIds.length > 0) parts.push(`customer_id.in.(${customerIds.join(',')})`);
  return parts.join(',');
}

// --- errors -----------------------------------------------------------------

/** One row of the conflict list the RPCs return, and put in the error DETAIL. */
export interface BookingConflict {
  kind: 'property_archived' | 'property_inactive' | 'block' | 'booking';
  id: string;
  label: string;
  starts_at: string | null;
  ends_at: string | null;
}

/** Structural shape of a PostgrestError, so this file needs no SDK import. */
export interface PostgrestErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

const BOOKING_ERROR_KEYS: Record<string, TranslationKey> = {
  auth_required: 'error.unauthorized',
  forbidden: 'error.unauthorized',
  booking_conflict: 'booking.conflict.blocked',
  conflict_reason_required: 'booking.conflict.reason',
  price_reason_required: 'booking.price.override.reason',
  invalid_price: 'validation.price',
  invalid_range: 'validation.range.end',
  invalid_action: 'error.generic',
  booking_not_found: 'booking.error.notFound',
  property_not_found: 'property.notFound',
  customer_not_found: 'customer.notFound',
  status_not_found: 'booking.error.notFound',
  property_unavailable: 'booking.error.propertyUnavailable',
};

/** Maps a booking RPC failure onto a translation key. Shared by both apps. */
export function bookingErrorKey(error: PostgrestErrorLike): TranslationKey {
  const message = (error.message ?? '').trim();
  // Postgres prefixes RPC errors with nothing, but PostgREST may wrap them.
  for (const [name, key] of Object.entries(BOOKING_ERROR_KEYS)) {
    if (message === name || message.includes(name)) return key;
  }
  if (error.code === '23505') return 'booking.error.notFound';
  return 'error.generic';
}

/** The conflicts a refused write carried in its DETAIL field. */
export function conflictsFromError(error: PostgrestErrorLike): BookingConflict[] {
  if (!error.details) return [];
  try {
    const parsed: unknown = JSON.parse(error.details);
    return Array.isArray(parsed) ? (parsed as BookingConflict[]) : [];
  } catch {
    return [];
  }
}

/** Only a date clash can be overridden; a dead property cannot. */
export function isOverridable(conflicts: readonly BookingConflict[]): boolean {
  return (
    conflicts.length > 0 &&
    conflicts.every((conflict) => conflict.kind === 'block' || conflict.kind === 'booking')
  );
}
