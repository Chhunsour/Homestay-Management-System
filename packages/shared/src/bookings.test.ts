import { strict as assert } from 'node:assert';
import test from 'node:test';
import { zonedTimeToUtc } from './availability.ts';
import {
  addMonths,
  bookingDays,
  bookingErrorKey,
  bookingSearchFilter,
  conflictsFromError,
  coversDate,
  finalPrice,
  isOverridable,
  findStatusByCode,
  isPendingExpired,
  isWeekendDate,
  monthGrid,
  pendingMinutesLeft,
  priceBooking,
  statusLabel,
  toOccupancy,
  weekGrid,
} from './bookings.ts';
import { createTranslator } from './i18n/index.ts';
import type { BookingStatus, BookingWithDetails } from './types.ts';

const TZ = 'Asia/Phnom_Penh';
// 2026-09-07 is a Monday, so 11/12/13 are Friday, Saturday and Sunday.
const PRICING = { weekday_price: 35, weekend_price: 50, currency: 'USD' as const };

/** A wall-clock time in the business's zone, as the form would submit it. */
const at = (day: string, time = '14:00') => zonedTimeToUtc(`${day}T${time}`, TZ).toISOString();

const price = (from: string, to: string, fromTime = '14:00', toTime = '12:00') =>
  priceBooking(PRICING, at(from, fromTime), at(to, toTime), TZ);

test('weekday-only stay is charged at the weekday rate', () => {
  const result = price('2026-09-07', '2026-09-10'); // Mon, Tue, Wed
  assert.deepEqual(
    result.days.map((day) => day.date),
    ['2026-09-07', '2026-09-08', '2026-09-09'],
  );
  assert.equal(result.weekdayCount, 3);
  assert.equal(result.weekendCount, 0);
  assert.equal(result.total, 105);
  assert.equal(result.currency, 'USD');
});

test('weekend-only stay is charged at the weekend rate', () => {
  const result = price('2026-09-11', '2026-09-14'); // Fri, Sat, Sun
  assert.equal(result.weekdayCount, 0);
  assert.equal(result.weekendCount, 3);
  assert.equal(result.total, 150);
});

test('a mixed stay prices each day on its own', () => {
  const result = price('2026-09-10', '2026-09-12'); // Thu 35 + Fri 50
  assert.deepEqual(
    result.days.map((day) => day.rate),
    [35, 50],
  );
  assert.equal(result.total, 85);
});

test('a same-day booking is charged as one day, not zero', () => {
  const result = price('2026-09-07', '2026-09-07', '09:00', '17:00');
  assert.equal(result.days.length, 1);
  assert.equal(result.total, 35);
});

test('a week-long stay counts four weekdays and three weekend days', () => {
  const result = price('2026-09-07', '2026-09-14'); // Mon to Mon
  assert.equal(result.days.length, 7);
  assert.equal(result.weekdayCount, 4);
  assert.equal(result.weekendCount, 3);
  assert.equal(result.total, 4 * 35 + 3 * 50);
});

test('totals with fractional rates keep two decimals', () => {
  const result = priceBooking(
    // Strings, the way `numeric` can arrive from PostgREST.
    { weekday_price: '32.55', weekend_price: '40.10', currency: 'USD' },
    at('2026-09-07'),
    at('2026-09-10'),
    TZ,
  );
  assert.equal(result.total, 97.65);
});

test('days are counted in the business time zone, not UTC', () => {
  // 2026-09-10T18:00Z is already Friday 01:00 in Phnom Penh.
  const local = priceBooking(PRICING, '2026-09-10T18:00:00.000Z', '2026-09-11T18:00:00.000Z', TZ);
  assert.deepEqual(
    local.days.map((day) => day.date),
    ['2026-09-11'],
  );
  assert.equal(local.total, 50); // Friday

  const utc = priceBooking(PRICING, '2026-09-10T18:00:00.000Z', '2026-09-11T18:00:00.000Z', 'UTC');
  assert.deepEqual(
    utc.days.map((day) => day.date),
    ['2026-09-10'],
  );
  assert.equal(utc.total, 35); // Thursday
});

test('a stay that crosses midnight UTC still starts on its local date', () => {
  // 23:30 local on the 11th is 16:30Z the same day; 00:30 local on the 12th is
  // 17:30Z on the 11th. Both must be read as local dates.
  const result = priceBooking(PRICING, at('2026-09-11', '23:30'), at('2026-09-13', '00:30'), TZ);
  assert.deepEqual(
    result.days.map((day) => day.date),
    ['2026-09-11', '2026-09-12'],
  );
});

test('bookingDays refuses a backwards range', () => {
  assert.deepEqual(bookingDays(at('2026-09-10'), at('2026-09-07'), TZ), []);
});

test('isWeekendDate covers Friday to Sunday', () => {
  assert.deepEqual(
    ['2026-09-07', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14'].map(
      isWeekendDate,
    ),
    [false, false, true, true, true, false],
  );
});

test('a manual override wins over the calculated total, which is kept', () => {
  const booking = { calculated_price: 105, final_price: 90 };
  assert.equal(finalPrice(booking), 90);
  // The original quote is still there — a later price change must not rewrite it.
  assert.equal(booking.calculated_price, 105);
  assert.equal(finalPrice({ calculated_price: 105, final_price: null }), 105);
});

// --- statuses ---------------------------------------------------------------

function status(overrides: Partial<BookingStatus> = {}): BookingStatus {
  return {
    id: 'status-1',
    business_id: 'business-1',
    name: 'Pending',
    code: 'pending',
    color: '#b45309',
    sort_order: 1,
    is_system: true,
    is_active: true,
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    ...overrides,
  };
}

test('seeded statuses translate; renamed ones keep the owner wording', () => {
  const km = createTranslator('km');
  assert.equal(statusLabel(status(), km), km('booking.status.pending'));
  assert.notEqual(statusLabel(status(), km), 'Pending');
  assert.equal(statusLabel(status({ name: 'Holding' }), km), 'Holding');
  assert.equal(statusLabel(status({ is_system: false, name: 'Deposit paid' }), km), 'Deposit paid');
});

test('findStatusByCode prefers the system row over a look-alike', () => {
  const custom = status({ id: 'custom', is_system: false, name: 'Cancelled by guest' });
  const system = status({ id: 'system', code: 'cancelled', name: 'Cancelled' });
  assert.equal(findStatusByCode([custom, system], 'cancelled')?.id, 'system');
  assert.equal(findStatusByCode([custom], 'confirmed'), null);
});

test('only pending, confirmed and completed bookings hold their dates', () => {
  const booking = (code: BookingStatus['code']) =>
    ({
      id: `booking-${code}`,
      business_id: 'business-1',
      property_id: 'property-1',
      booking_number: 'BK-2026-000001',
      check_in_at: at('2026-09-07'),
      check_out_at: at('2026-09-09'),
      status: status({ code }),
    }) as unknown as BookingWithDetails;

  assert.deepEqual(
    toOccupancy(
      ['pending', 'confirmed', 'completed', 'cancelled'].map((code) =>
        booking(code as BookingStatus['code']),
      ),
    ).map((row) => row.blocks),
    [true, true, true, false],
  );
});

// --- pending expiry ---------------------------------------------------------

const NOW = new Date('2026-09-07T10:00:00.000Z');

test('an expired hold is one that lapsed and nobody has ruled on', () => {
  const base = { status: status(), pending_resolved_at: null };
  assert.equal(
    isPendingExpired({ ...base, pending_expires_at: '2026-09-07T09:30:00.000Z' }, NOW),
    true,
  );
  // Still running.
  assert.equal(
    isPendingExpired({ ...base, pending_expires_at: '2026-09-07T10:30:00.000Z' }, NOW),
    false,
  );
  // Someone already decided to keep it.
  assert.equal(
    isPendingExpired(
      {
        ...base,
        pending_expires_at: '2026-09-07T09:30:00.000Z',
        pending_resolved_at: '2026-09-07T09:40:00.000Z',
      },
      NOW,
    ),
    false,
  );
  // Confirmed bookings have no hold to lapse.
  assert.equal(
    isPendingExpired(
      {
        status: status({ code: 'confirmed' }),
        pending_expires_at: '2026-09-07T09:30:00.000Z',
        pending_resolved_at: null,
      },
      NOW,
    ),
    false,
  );
});

test('pendingMinutesLeft goes negative once the hold lapses', () => {
  assert.equal(pendingMinutesLeft({ pending_expires_at: '2026-09-07T10:25:00.000Z' }, NOW), 25);
  assert.equal(pendingMinutesLeft({ pending_expires_at: '2026-09-07T09:45:00.000Z' }, NOW), -15);
  assert.equal(pendingMinutesLeft({ pending_expires_at: null }, NOW), null);
});

// --- calendar ---------------------------------------------------------------

test('a month grid is whole Monday-first weeks around the month', () => {
  // 2026-09-01 is a Tuesday, so the grid opens on Monday the 31st of August.
  const september = monthGrid('2026-09');
  assert.equal(september[0], '2026-08-31');
  assert.equal(september.length % 7, 0);
  assert.ok(september.includes('2026-09-30'));
  // February 2026 starts on a Sunday: six rows, not five.
  assert.equal(monthGrid('2026-02')[0], '2026-01-26');
});

test('addMonths crosses the year boundary in both directions', () => {
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-09', 0), '2026-09');
});

test('a week grid runs Monday to Sunday whatever day you ask for', () => {
  assert.deepEqual(weekGrid('2026-09-13'), [
    '2026-09-07',
    '2026-09-08',
    '2026-09-09',
    '2026-09-10',
    '2026-09-11',
    '2026-09-12',
    '2026-09-13',
  ]);
  assert.equal(weekGrid('2026-09-07')[0], '2026-09-07');
});

test('a stay covers its nights but not its checkout day', () => {
  const stay = { check_in_at: at('2026-09-07'), check_out_at: at('2026-09-09', '12:00') };
  assert.deepEqual(
    ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09'].map((date) =>
      coversDate(stay, date, TZ),
    ),
    [false, true, true, false],
  );
  // A day-use booking still occupies the one day it is on.
  const dayUse = {
    check_in_at: at('2026-09-07', '09:00'),
    check_out_at: at('2026-09-07', '17:00'),
  };
  assert.equal(coversDate(dayUse, '2026-09-07', TZ), true);
});

// --- search and errors ------------------------------------------------------

test('bookingSearchFilter matches the number, and the guests found separately', () => {
  assert.equal(bookingSearchFilter('BK-2026', []), 'booking_number.ilike.%BK-2026%');
  assert.equal(
    bookingSearchFilter('sok', ['id-1', 'id-2']),
    'booking_number.ilike.%sok%,customer_id.in.(id-1,id-2)',
  );
  // Only guests matched: the term itself was pure PostgREST syntax.
  assert.equal(bookingSearchFilter('%%', ['id-1']), 'customer_id.in.(id-1)');
  assert.equal(bookingSearchFilter('   ', []), null);
});

test('booking RPC failures become translation keys, never raw SQL text', () => {
  assert.equal(bookingErrorKey({ message: 'booking_conflict' }), 'booking.conflict.blocked');
  assert.equal(bookingErrorKey({ message: 'forbidden' }), 'error.unauthorized');
  assert.equal(
    bookingErrorKey({ message: 'property_unavailable' }),
    'booking.error.propertyUnavailable',
  );
  assert.equal(bookingErrorKey({ message: 'something else entirely' }), 'error.generic');
});

test('the refused write carries its conflicts in DETAIL', () => {
  const conflicts = conflictsFromError({
    message: 'booking_conflict',
    details:
      '[{"kind":"booking","id":"b1","label":"BK-2026-000001",' +
      '"starts_at":"2026-09-10T07:00:00+00:00","ends_at":"2026-09-12T05:00:00+00:00"}]',
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.label, 'BK-2026-000001');
  assert.equal(isOverridable(conflicts), true);

  // A switched-off property is not something an owner may book over.
  assert.equal(
    isOverridable([
      { kind: 'property_inactive', id: 'p1', label: 'Villa', starts_at: null, ends_at: null },
    ]),
    false,
  );
  assert.equal(isOverridable([]), false);
  // Garbage in the detail field must not throw on a form submit.
  assert.deepEqual(conflictsFromError({ details: 'not json' }), []);
});
