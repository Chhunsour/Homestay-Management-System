import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  checkAvailability,
  isWeekend,
  rateForNight,
  rangesOverlap,
  utcToZonedInput,
  zonedTimeToUtc,
} from './availability.ts';
import type { BookingOccupancy } from './availability.ts';
import type { Property, PropertyBlock } from './types.ts';

const BUSINESS = '11111111-1111-4111-8111-111111111111';
const OTHER_BUSINESS = '22222222-2222-4222-8222-222222222222';
const PROPERTY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PROPERTY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const property: Pick<Property, 'id' | 'business_id' | 'is_active' | 'archived_at'> = {
  id: PROPERTY,
  business_id: BUSINESS,
  is_active: true,
  archived_at: null,
};

function block(overrides: Partial<PropertyBlock> = {}): PropertyBlock {
  return {
    id: 'block-1',
    business_id: BUSINESS,
    property_id: PROPERTY,
    starts_at: '2026-09-10T07:00:00.000Z', // 14:00 Phnom Penh
    ends_at: '2026-09-12T05:00:00.000Z', // 12:00 Phnom Penh
    reason: 'maintenance',
    note: null,
    status: 'active',
    created_by: null,
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    ...overrides,
  };
}

const range = (start: string, end: string) => ({ start, end });

test('overlapping ranges are reported as block conflicts', () => {
  const result = checkAvailability({
    property,
    blocks: [block()],
    range: range('2026-09-11T07:00:00.000Z', '2026-09-13T05:00:00.000Z'),
  });
  assert.equal(result.available, false);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.kind, 'block');
  assert.equal(result.conflicts[0]?.reason, 'maintenance');
});

test('a range fully containing a block still conflicts', () => {
  const result = checkAvailability({
    property,
    blocks: [block()],
    range: range('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  });
  assert.equal(result.available, false);
});

test('adjacent ranges do not overlap: the range is half-open', () => {
  // Starts exactly when the block ends.
  const after = checkAvailability({
    property,
    blocks: [block()],
    range: range('2026-09-12T05:00:00.000Z', '2026-09-14T05:00:00.000Z'),
  });
  assert.deepEqual(after, { available: true, conflicts: [] });

  // Ends exactly when the block starts.
  const before = checkAvailability({
    property,
    blocks: [block()],
    range: range('2026-09-08T07:00:00.000Z', '2026-09-10T07:00:00.000Z'),
  });
  assert.equal(before.available, true);
});

test('an end at or before the start is an invalid range, not an availability answer', () => {
  for (const bad of [
    range('2026-09-12T05:00:00.000Z', '2026-09-10T07:00:00.000Z'),
    range('2026-09-10T07:00:00.000Z', '2026-09-10T07:00:00.000Z'),
    range('not-a-date', '2026-09-10T07:00:00.000Z'),
  ]) {
    const result = checkAvailability({ property, blocks: [block()], range: bad });
    assert.equal(result.available, false);
    assert.deepEqual(result.conflicts, [{ kind: 'invalid_range' }]);
  }
});

test('inactive and archived properties are unavailable even with no blocks', () => {
  const inactive = checkAvailability({
    property: { ...property, is_active: false },
    blocks: [],
    range: range('2026-09-20T07:00:00.000Z', '2026-09-22T05:00:00.000Z'),
  });
  assert.equal(inactive.available, false);
  assert.deepEqual(
    inactive.conflicts.map((c) => c.kind),
    ['property_inactive'],
  );

  const archived = checkAvailability({
    property: { ...property, is_active: false, archived_at: '2026-08-01T00:00:00.000Z' },
    blocks: [],
    range: range('2026-09-20T07:00:00.000Z', '2026-09-22T05:00:00.000Z'),
  });
  assert.deepEqual(
    archived.conflicts.map((c) => c.kind),
    ['property_archived', 'property_inactive'],
  );
});

test('cancelled blocks no longer make a property unavailable', () => {
  const result = checkAvailability({
    property,
    blocks: [block({ status: 'cancelled' })],
    range: range('2026-09-11T07:00:00.000Z', '2026-09-12T00:00:00.000Z'),
  });
  assert.equal(result.available, true);
});

test('tenant isolation: blocks from another business or property are ignored', () => {
  const overlapping = range('2026-09-11T07:00:00.000Z', '2026-09-12T00:00:00.000Z');

  const foreignBusiness = checkAvailability({
    property,
    // Same property id, wrong tenant: a forged row must not affect this property.
    blocks: [block({ id: 'foreign', business_id: OTHER_BUSINESS })],
    range: overlapping,
  });
  assert.equal(foreignBusiness.available, true);

  const foreignProperty = checkAvailability({
    property,
    blocks: [block({ id: 'sibling', property_id: OTHER_PROPERTY })],
    range: overlapping,
  });
  assert.equal(foreignProperty.available, true);
});

// --- existing bookings ------------------------------------------------------

function occupancy(overrides: Partial<BookingOccupancy> = {}): BookingOccupancy {
  return {
    id: 'booking-1',
    business_id: BUSINESS,
    property_id: PROPERTY,
    check_in_at: '2026-09-20T07:00:00.000Z', // 14:00 Phnom Penh
    check_out_at: '2026-09-22T05:00:00.000Z', // 12:00 Phnom Penh
    blocks: true,
    booking_number: 'BK-2026-000001',
    ...overrides,
  };
}

test('an existing booking makes the property unavailable', () => {
  const result = checkAvailability({
    property,
    blocks: [],
    bookings: [occupancy()],
    range: range('2026-09-21T07:00:00.000Z', '2026-09-23T05:00:00.000Z'),
  });
  assert.equal(result.available, false);
  assert.equal(result.conflicts[0]?.kind, 'booking');
  assert.equal(result.conflicts[0]?.bookingNumber, 'BK-2026-000001');
});

test('back-to-back bookings are allowed: checkout time is check-in time', () => {
  const result = checkAvailability({
    property,
    blocks: [],
    bookings: [occupancy()],
    // Starts at 12:00, the minute the previous guest leaves.
    range: range('2026-09-22T05:00:00.000Z', '2026-09-24T05:00:00.000Z'),
  });
  assert.deepEqual(result, { available: true, conflicts: [] });
});

test('a cancelled booking hands its dates back', () => {
  const result = checkAvailability({
    property,
    blocks: [],
    bookings: [occupancy({ blocks: false })],
    range: range('2026-09-21T07:00:00.000Z', '2026-09-23T05:00:00.000Z'),
  });
  assert.equal(result.available, true);
});

test('a booking being edited does not conflict with itself', () => {
  const overlapping = range('2026-09-21T07:00:00.000Z', '2026-09-23T05:00:00.000Z');
  assert.equal(
    checkAvailability({
      property,
      blocks: [],
      bookings: [occupancy()],
      excludeBookingId: 'booking-1',
      range: overlapping,
    }).available,
    true,
  );
  // Someone else's booking on the same dates still blocks.
  assert.equal(
    checkAvailability({
      property,
      blocks: [],
      bookings: [occupancy(), occupancy({ id: 'booking-2' })],
      excludeBookingId: 'booking-1',
      range: overlapping,
    }).available,
    false,
  );
});

test('tenant isolation: bookings from another business or property are ignored', () => {
  const overlapping = range('2026-09-21T07:00:00.000Z', '2026-09-23T05:00:00.000Z');
  for (const foreign of [
    occupancy({ business_id: OTHER_BUSINESS }),
    occupancy({ property_id: OTHER_PROPERTY }),
  ]) {
    assert.equal(
      checkAvailability({ property, blocks: [], bookings: [foreign], range: overlapping })
        .available,
      true,
    );
  }
});

test('blocks and bookings are both reported when both are in the way', () => {
  const result = checkAvailability({
    property,
    blocks: [block({ starts_at: '2026-09-20T07:00:00.000Z', ends_at: '2026-09-21T05:00:00.000Z' })],
    bookings: [occupancy()],
    range: range('2026-09-20T07:00:00.000Z', '2026-09-23T05:00:00.000Z'),
  });
  assert.deepEqual(
    result.conflicts.map((conflict) => conflict.kind),
    ['block', 'booking'],
  );
});

test('rangesOverlap treats touching endpoints as free', () => {
  assert.equal(rangesOverlap(10, 20, 20, 30), false);
  assert.equal(rangesOverlap(10, 20, 5, 10), false);
  assert.equal(rangesOverlap(10, 20, 19, 30), true);
});

// --- Asia/Phnom_Penh --------------------------------------------------------

test('wall-clock input is interpreted in the business time zone', () => {
  // Phnom Penh is UTC+7 year round.
  assert.equal(
    zonedTimeToUtc('2026-09-10T14:00', 'Asia/Phnom_Penh').toISOString(),
    '2026-09-10T07:00:00.000Z',
  );
  assert.equal(utcToZonedInput('2026-09-10T07:00:00.000Z', 'Asia/Phnom_Penh'), '2026-09-10T14:00');
  // Round trip, including across a UTC date boundary.
  const late = '2026-09-10T23:30';
  assert.equal(utcToZonedInput(zonedTimeToUtc(late, 'Asia/Phnom_Penh'), 'Asia/Phnom_Penh'), late);
});

test('weekend is Friday to Sunday in the business time zone, not UTC', () => {
  // 2026-09-11 is a Friday. 18:00 UTC on Thursday is already Friday 01:00 there.
  assert.equal(isWeekend('2026-09-10T18:00:00.000Z', 'Asia/Phnom_Penh'), true);
  assert.equal(isWeekend('2026-09-10T18:00:00.000Z', 'UTC'), false);

  const local = (day: string) => zonedTimeToUtc(`${day}T12:00`, 'Asia/Phnom_Penh');
  assert.equal(isWeekend(local('2026-09-10'), 'Asia/Phnom_Penh'), false); // Thu
  assert.equal(isWeekend(local('2026-09-11'), 'Asia/Phnom_Penh'), true); // Fri
  assert.equal(isWeekend(local('2026-09-12'), 'Asia/Phnom_Penh'), true); // Sat
  assert.equal(isWeekend(local('2026-09-13'), 'Asia/Phnom_Penh'), true); // Sun
  assert.equal(isWeekend(local('2026-09-14'), 'Asia/Phnom_Penh'), false); // Mon
});

test('rateForNight picks the weekend rate on Friday to Sunday nights', () => {
  const pricing = { weekday_price: 35, weekend_price: 50 };
  const local = (day: string) => zonedTimeToUtc(`${day}T14:00`, 'Asia/Phnom_Penh');
  assert.equal(rateForNight(pricing, local('2026-09-10'), 'Asia/Phnom_Penh'), 35);
  assert.equal(rateForNight(pricing, local('2026-09-11'), 'Asia/Phnom_Penh'), 50);
  assert.equal(rateForNight(pricing, local('2026-09-13'), 'Asia/Phnom_Penh'), 50);
  assert.equal(rateForNight(pricing, local('2026-09-14'), 'Asia/Phnom_Penh'), 35);
});
