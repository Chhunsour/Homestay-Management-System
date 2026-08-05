import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  bookingPaymentStatus,
  canCorrectPayment,
  canOverridePayment,
  canRefundPayment,
  canVerifyPayment,
  canVoidPayment,
  depositRequired,
  duplicatesFromError,
  findDuplicates,
  isBlockingDuplicate,
  isOverpayment,
  overpaymentFromError,
  paymentErrorKey,
  reachesDeposit,
  round2,
  summarizeBookingPayments,
  sumPayments,
} from './payments.ts';
import type { Payment } from './types.ts';

// A payment row with only the fields these functions read; the rest of the
// table is never touched by the calculator.
function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: over.id ?? 'p1',
    business_id: 'b1',
    booking_id: 'bk1',
    customer_id: 'c1',
    payment_number: over.payment_number ?? 'PM-2026-000001',
    amount: over.amount ?? 50,
    currency: 'USD',
    exchange_rate: null,
    method: over.method ?? 'aba',
    payment_type: over.payment_type ?? 'deposit',
    status: over.status ?? 'recorded',
    paid_at: over.paid_at ?? '2026-08-05T10:00:00.000Z',
    reference: over.reference ?? null,
    payer_name: null,
    note: null,
    duplicate_override: false,
    overpayment_override: false,
    override_reason: null,
    verified_by: null,
    verified_at: null,
    created_by: null,
    created_at: '2026-08-05T10:00:00.000Z',
    updated_at: '2026-08-05T10:00:00.000Z',
    ...over,
  };
}

// --- rounding ---------------------------------------------------------------

test('round2 matches numeric(12,2) on the cases floats get wrong', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(100 / 3), 33.33);
});

// --- deposits ---------------------------------------------------------------

test('the deposit is half the total, rounded once', () => {
  assert.equal(depositRequired(100), 50);
  assert.equal(depositRequired(75.55), 37.78);
  assert.equal(depositRequired('120.00'), 60);
});

// --- totals -----------------------------------------------------------------

test('voided rows stop counting; recorded ones still count', () => {
  const totals = sumPayments([
    payment({ id: 'a', amount: 50 }),
    payment({ id: 'b', amount: 30, status: 'voided' }),
    payment({ id: 'c', amount: 20, status: 'verified' }),
  ]);
  // 50 + 20 — the void is gone, the unverified one is not.
  assert.deepEqual(totals, { totalPaid: 70, refundTotal: 0, netPaid: 70 });
});

test('a refund is its own row and subtracts from the net', () => {
  const totals = sumPayments([
    payment({ id: 'a', amount: 100 }),
    payment({ id: 'b', amount: 40, payment_type: 'refund' }),
    payment({ id: 'c', amount: 10, payment_type: 'refund', status: 'voided' }),
  ]);
  assert.deepEqual(totals, { totalPaid: 100, refundTotal: 40, netPaid: 60 });
});

// --- the status ladder ------------------------------------------------------

test('the booking status ladder, rung by rung', () => {
  const ladder = (paid: number, refunded = 0): string =>
    bookingPaymentStatus({
      bookingTotal: 100,
      totals: { totalPaid: paid, refundTotal: refunded, netPaid: round2(paid - refunded) },
    });

  assert.equal(ladder(0), 'unpaid');
  assert.equal(ladder(20), 'partial'); // below the 50% deposit
  assert.equal(ladder(49.99), 'partial');
  assert.equal(ladder(50), 'deposit_paid'); // exactly the deposit
  assert.equal(ladder(75), 'deposit_paid');
  assert.equal(ladder(100), 'paid');
  assert.equal(ladder(120), 'overpaid');
  // Paid then fully refunded reads `refunded`, not `unpaid`: the difference
  // matters to whoever picks up the phone next.
  assert.equal(ladder(100, 100), 'refunded');
  assert.equal(ladder(100, 60), 'partial');
});

test('summarizeBookingPayments reports a balance, never a negative one', () => {
  const summary = summarizeBookingPayments({
    bookingTotal: 200,
    currency: 'USD',
    payments: [payment({ amount: 250 })],
  });
  assert.equal(summary.payment_status, 'overpaid');
  assert.equal(summary.net_paid, 250);
  assert.equal(summary.balance, 0); // not -50
  assert.equal(summary.paid_percent, 125);
  assert.equal(summary.deposit_required, 100);
});

test('a free booking does not divide by zero', () => {
  const summary = summarizeBookingPayments({
    bookingTotal: 0,
    currency: 'KHR',
    payments: [],
  });
  assert.equal(summary.paid_percent, 0);
  assert.equal(summary.payment_status, 'unpaid');
});

// --- the two warnings -------------------------------------------------------

test('overpayment and deposit thresholds are inclusive the right way round', () => {
  const summary = { booking_total: 100, net_paid: 40 };
  assert.equal(isOverpayment({ summary, amount: 60 }), false); // exactly full
  assert.equal(isOverpayment({ summary, amount: 60.01 }), true);
  assert.equal(reachesDeposit({ summary, amount: 10 }), true); // 40 + 10 = 50
  assert.equal(reachesDeposit({ summary, amount: 9.99 }), false);
});

// --- duplicates -------------------------------------------------------------

test('a matching transaction reference is a blocking duplicate', () => {
  const found = findDuplicates({
    candidate: { reference: ' ABC-123 ', amount: 999, paidAt: '2026-01-01T00:00:00.000Z' },
    payments: [payment({ reference: 'abc-123' })],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.kind, 'reference');
  assert.equal(isBlockingDuplicate(found), true);
});

test('same amount inside the window warns; outside it does not', () => {
  const near = findDuplicates({
    candidate: { amount: 50, paidAt: '2026-08-05T10:20:00.000Z' },
    payments: [payment({ amount: 50 })],
  });
  assert.equal(near[0]?.kind, 'amount');
  // A warning, not a block: a guest paying the same sum twice is legitimate.
  assert.equal(isBlockingDuplicate(near), false);

  const far = findDuplicates({
    candidate: { amount: 50, paidAt: '2026-08-06T10:00:00.000Z' },
    payments: [payment({ amount: 50 })],
  });
  assert.deepEqual(far, []);
});

test('the same screenshot twice is caught by its checksum', () => {
  const checksum = 'a'.repeat(64);
  const found = findDuplicates({
    candidate: { amount: 12, paidAt: '2026-01-01T00:00:00.000Z', checksum },
    payments: [{ ...payment({ amount: 99 }), proofs: [{ checksum }] }],
  });
  assert.equal(found[0]?.kind, 'file');
});

test('voided payments are not duplicates of anything', () => {
  const found = findDuplicates({
    candidate: { reference: 'X1', amount: 50, paidAt: '2026-08-05T10:00:00.000Z' },
    payments: [payment({ reference: 'X1', status: 'voided' })],
  });
  assert.deepEqual(found, []);
});

// --- permissions ------------------------------------------------------------

test('staff record payments and nothing else', () => {
  const recorded = payment();
  assert.equal(canOverridePayment('staff'), false);
  assert.equal(canCorrectPayment('staff', recorded), false);
  assert.equal(canRefundPayment('staff', recorded), false);
  assert.equal(canVoidPayment('staff', recorded), false);
  assert.equal(canVerifyPayment('staff', recorded), false);
  // ...including on a payment they recorded themselves and then verified.
  assert.equal(canCorrectPayment('staff', payment({ status: 'verified' })), false);
});

test('managers do everything except void', () => {
  const recorded = payment();
  assert.equal(canOverridePayment('manager'), true);
  assert.equal(canCorrectPayment('manager', recorded), true);
  assert.equal(canRefundPayment('manager', recorded), true);
  assert.equal(canVerifyPayment('manager', recorded), true);
  assert.equal(canVoidPayment('manager', recorded), false);
  assert.equal(canVoidPayment('owner', recorded), true);
});

test('a voided payment is terminal for everyone', () => {
  const voided = payment({ status: 'voided' });
  assert.equal(canCorrectPayment('owner', voided), false);
  assert.equal(canRefundPayment('owner', voided), false);
  assert.equal(canVoidPayment('owner', voided), false);
  assert.equal(canVerifyPayment('owner', voided), false);
  // A refund row is never itself refunded.
  assert.equal(canRefundPayment('owner', payment({ payment_type: 'refund' })), false);
});

// --- errors -----------------------------------------------------------------

test('RPC failures map onto translation keys', () => {
  assert.equal(paymentErrorKey({ message: 'duplicate_payment' }), 'payment.duplicate.blocked');
  assert.equal(paymentErrorKey({ message: 'overpayment' }), 'payment.overpayment.blocked');
  assert.equal(paymentErrorKey({ message: 'forbidden' }), 'error.unauthorized');
  // The partial unique index has to read the same as the explicit check.
  assert.equal(paymentErrorKey({ code: '23505', message: 'oops' }), 'payment.duplicate.blocked');
  assert.equal(paymentErrorKey({ message: 'something else' }), 'error.generic');
});

test('a refusal carries its evidence in DETAIL', () => {
  const duplicates = duplicatesFromError({
    message: 'duplicate_payment',
    details: JSON.stringify([{ kind: 'reference', payment_number: 'PM-2026-000009' }]),
  });
  assert.equal(duplicates[0]?.payment_number, 'PM-2026-000009');

  const over = overpaymentFromError({
    message: 'overpayment',
    details: JSON.stringify({
      booking_total: 100,
      net_paid: 90,
      amount: 30,
      currency: 'USD',
    }),
  });
  assert.equal(over?.amount, 30);

  // Garbage in DETAIL must not take a screen down with it.
  assert.deepEqual(duplicatesFromError({ details: 'not json' }), []);
  assert.equal(overpaymentFromError({ details: '{}' }), null);
  assert.equal(overpaymentFromError({}), null);
});
