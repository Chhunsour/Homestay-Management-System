import { DEFAULT_TIMEZONE, WEEKEND_DAYS } from './constants.ts';
import type { BlockReason } from './constants.ts';
import type { Property, PropertyBlock, PropertyPricing } from './types.ts';

/**
 * Availability and rate logic, shared by the web dashboard, the mobile app and
 * (later) the booking engine.
 *
 * Deliberately pure: it is handed rows, never a database client. That is what
 * lets Phase 4 add booking conflicts by passing an extra array and appending one
 * `ConflictKind`, instead of rewriting this.
 */

// --- time zones -------------------------------------------------------------
//
// Cambodia (Asia/Phnom_Penh, UTC+7) has no DST, so these are exact there. The
// two-pass offset lookup is only needed so other zones stay correct near a DST
// boundary. Intl is in every runtime we ship to; a date library is not worth it.

function offsetMs(instant: Date, timeZone: string): number {
  const label = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(label ?? '');
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === '-' ? -minutes : minutes) * 60_000;
}

/**
 * `'2026-08-04T14:00'` typed by a user in Phnom Penh -> the matching instant.
 * Applied twice so a wall clock inside a DST shift settles on the real offset.
 */
export function zonedTimeToUtc(local: string, timeZone: string = DEFAULT_TIMEZONE): Date {
  const naive = Date.parse(`${local.slice(0, 16)}:00.000Z`);
  if (Number.isNaN(naive)) return new Date(Number.NaN);
  const firstGuess = naive - offsetMs(new Date(naive), timeZone);
  return new Date(naive - offsetMs(new Date(firstGuess), timeZone));
}

/** The inverse, for pre-filling `<input type="datetime-local">`. */
export function utcToZonedInput(
  instant: Date | string,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + offsetMs(date, timeZone)).toISOString().slice(0, 16);
}

/** Friday, Saturday or Sunday *in the business's own time zone*. */
export function isWeekend(instant: Date | string, timeZone: string = DEFAULT_TIMEZONE): boolean {
  const date = instant instanceof Date ? instant : new Date(instant);
  const day = new Date(date.getTime() + offsetMs(date, timeZone)).getUTCDay();
  return (WEEKEND_DAYS as readonly number[]).includes(day);
}

/** Nightly rate for the night beginning on `instant`. `numeric` arrives as text. */
export function rateForNight(
  pricing: Pick<PropertyPricing, 'weekday_price' | 'weekend_price'>,
  instant: Date | string,
  timeZone: string = DEFAULT_TIMEZONE,
): number {
  return Number(isWeekend(instant, timeZone) ? pricing.weekend_price : pricing.weekday_price);
}

// --- availability -----------------------------------------------------------

export type ConflictKind =
  'invalid_range' | 'property_archived' | 'property_inactive' | 'block' | 'booking';

export interface AvailabilityConflict {
  kind: ConflictKind;
  /** Present for `kind: 'block'`. */
  blockId?: string;
  reason?: BlockReason;
  /** Present for `kind: 'booking'`. */
  bookingId?: string;
  bookingNumber?: string;
  startsAt?: string;
  endsAt?: string;
}

/**
 * The bits of a booking that decide whether dates are taken. Passed in rather
 * than fetched, and pre-resolved to `blocks` so this module never needs to know
 * how a status row maps to a code.
 */
export interface BookingOccupancy {
  id: string;
  business_id: string;
  property_id: string;
  check_in_at: string;
  check_out_at: string;
  /** False for cancelled bookings — they hand the dates back. */
  blocks: boolean;
  booking_number?: string;
}

export interface AvailabilityInput {
  property: Pick<Property, 'id' | 'business_id' | 'is_active' | 'archived_at'>;
  /** Every block known for this property. Foreign rows are ignored, not trusted. */
  blocks: readonly PropertyBlock[];
  /** Bookings known for this property. Same rule: foreign rows are ignored. */
  bookings?: readonly BookingOccupancy[];
  /** The booking being edited — it must not collide with itself. */
  excludeBookingId?: string;
  /** Half-open `[start, end)`: a stay ending when another begins is not a clash. */
  range: { start: Date | string; end: Date | string };
}

export interface AvailabilityResult {
  available: boolean;
  conflicts: AvailabilityConflict[];
}

/**
 * `[aStart, aEnd)` vs `[bStart, bEnd)`. Half-open, so touching ends are fine:
 * a block ending 14:00 does not collide with a stay starting 14:00.
 */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function checkAvailability(input: AvailabilityInput): AvailabilityResult {
  const { property, blocks, bookings = [], excludeBookingId, range } = input;
  const conflicts: AvailabilityConflict[] = [];

  const start = (range.start instanceof Date ? range.start : new Date(range.start)).getTime();
  const end = (range.end instanceof Date ? range.end : new Date(range.end)).getTime();

  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    // Reported rather than thrown: callers treat it like any other reason the
    // dates cannot be used, and there is no try/catch at every call site.
    return { available: false, conflicts: [{ kind: 'invalid_range' }] };
  }

  if (property.archived_at) conflicts.push({ kind: 'property_archived' });
  if (!property.is_active) conflicts.push({ kind: 'property_inactive' });

  for (const block of blocks) {
    // A caller passing another tenant's or another property's rows must not be
    // able to make this property look busy. RLS already filters the query; this
    // is the second lock, on the logic side.
    if (block.property_id !== property.id) continue;
    if (block.business_id !== property.business_id) continue;
    if (block.status !== 'active') continue;

    const blockStart = new Date(block.starts_at).getTime();
    const blockEnd = new Date(block.ends_at).getTime();
    if (Number.isNaN(blockStart) || Number.isNaN(blockEnd)) continue;

    if (rangesOverlap(start, end, blockStart, blockEnd)) {
      conflicts.push({
        kind: 'block',
        blockId: block.id,
        reason: block.reason,
        startsAt: block.starts_at,
        endsAt: block.ends_at,
      });
    }
  }

  for (const booking of bookings) {
    if (booking.property_id !== property.id) continue;
    if (booking.business_id !== property.business_id) continue;
    if (!booking.blocks) continue;
    if (booking.id === excludeBookingId) continue;

    const bookingStart = new Date(booking.check_in_at).getTime();
    const bookingEnd = new Date(booking.check_out_at).getTime();
    if (Number.isNaN(bookingStart) || Number.isNaN(bookingEnd)) continue;

    if (rangesOverlap(start, end, bookingStart, bookingEnd)) {
      conflicts.push({
        kind: 'booking',
        bookingId: booking.id,
        bookingNumber: booking.booking_number,
        startsAt: booking.check_in_at,
        endsAt: booking.check_out_at,
      });
    }
  }

  return { available: conflicts.length === 0, conflicts };
}

/** Convenience for calendars: is the property bookable at this instant at all? */
export function isPropertyBookable(property: Pick<Property, 'is_active' | 'archived_at'>): boolean {
  return property.is_active && property.archived_at === null;
}
