import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  buildConfirmationPayload,
  bytesToBase64,
  editedFields,
  initialOcrFlowState,
  lowConfidenceFields,
  ocrFlowReducer,
  reviewValuesFromExtraction,
  type OcrBookingSelection,
  type OcrFlowState,
} from './ocrReview.ts';
import { buildProviderFailureResult, parseReceiptText } from './ocr.ts';
import { ocrBookingSchema, ocrReviewSchema } from './schemas.ts';
import type { PaymentDuplicate } from './types.ts';

const ABA_RECEIPT = `ABA Mobile
Payment Successful
From: SOK DARA
To: HOMESTAY BUSINESS
Amount: $150.00
Transaction ID: FT23219876543
21-Aug-2026 02:32 PM`;

const DUPLICATE: PaymentDuplicate = {
  kind: 'reference',
  id: 'pay-1',
  payment_number: 'PM-2026-000001',
  amount: 150,
  currency: 'USD',
  paid_at: '2026-08-21T14:32:00.000Z',
  reference: 'FT23219876543',
  status: 'recorded',
};

// --- pure helpers ------------------------------------------------------------

test('successful extraction review: OCR values populate the form as-is', () => {
  const extraction = parseReceiptText(ABA_RECEIPT);
  const values = reviewValuesFromExtraction(extraction);
  assert.equal(values.payerName, 'SOK DARA');
  assert.equal(values.amount, '150');
  assert.equal(values.currency, 'USD');
  assert.equal(values.reference, 'FT23219876543');
  assert.equal(values.method, 'aba');
});

test('manual correction: editedFields reports only what changed', () => {
  const original = reviewValuesFromExtraction(parseReceiptText(ABA_RECEIPT));
  const corrected = { ...original, amount: '155', payerName: 'Sok Dara' };
  assert.deepEqual(editedFields(original, corrected), ['payerName', 'amount']);
  assert.deepEqual(editedFields(original, original), []);
});

test('low-confidence warning: flags fields OCR found but is unsure about', () => {
  // DD/MM/YYYY dates parse at 0.7 confidence, below the 0.6 threshold is untouched
  // by this fixture — use the threshold parameter to prove the mechanism instead.
  const extraction = parseReceiptText(ABA_RECEIPT);
  assert.deepEqual(lowConfidenceFields(extraction, 0), []);
  assert.ok(lowConfidenceFields(extraction, 1).length > 0);
});

test('bytesToBase64 matches known encodings, including padding', () => {
  const encode = (s: string) => bytesToBase64(new TextEncoder().encode(s));
  assert.equal(encode(''), '');
  assert.equal(encode('f'), 'Zg==');
  assert.equal(encode('fo'), 'Zm8=');
  assert.equal(encode('foo'), 'Zm9v');
  assert.equal(encode('foobar'), 'Zm9vYmFy');
});

// --- the flow reducer ---------------------------------------------------------

function freshState(): OcrFlowState {
  return initialOcrFlowState('biz-1');
}

test('OCR retry: a failure returns to source with an error, and retry re-enters processing', () => {
  let state = ocrFlowReducer(freshState(), { type: 'START_OCR' });
  assert.equal(state.step, 'processing');

  state = ocrFlowReducer(state, { type: 'OCR_FAILED', errorKey: 'provider_error' });
  assert.equal(state.step, 'source');
  assert.equal(state.errorKey, 'provider_error');

  state = ocrFlowReducer(state, { type: 'RETRY' });
  assert.equal(state.step, 'processing');
  assert.equal(state.errorKey, null);
});

test('cross-business access denial surfaces the same way any other OCR failure does', () => {
  const state = ocrFlowReducer(freshState(), { type: 'OCR_FAILED', errorKey: 'proof_not_found' });
  assert.equal(state.step, 'source');
  assert.equal(state.errorKey, 'proof_not_found');
});

test('manual fallback: skipping OCR opens a blank, editable review step', () => {
  const state = ocrFlowReducer(freshState(), { type: 'SKIP_TO_MANUAL' });
  assert.equal(state.step, 'review');
  assert.equal(state.manualEntry, true);
  assert.equal(state.extraction, null);
  assert.equal(state.values.amount, '');
});

test('field edits and back navigation never lose what was typed', () => {
  let state = ocrFlowReducer(freshState(), {
    type: 'OCR_SUCCEEDED',
    extraction: parseReceiptText(ABA_RECEIPT),
    duplicates: [],
    possibleDuplicate: false,
  });
  state = ocrFlowReducer(state, { type: 'FIELD_CHANGED', field: 'amount', value: '160' });
  state = ocrFlowReducer(state, { type: 'CONTINUE_REVIEW' });
  assert.equal(state.step, 'customer');
  assert.equal(state.values.amount, '160');

  // Back to review, forward again — the correction survives the round trip.
  state = ocrFlowReducer(state, { type: 'BACK' });
  assert.equal(state.step, 'review');
  assert.equal(state.values.amount, '160');
});

const EXISTING_BOOKING: OcrBookingSelection = {
  type: 'existing',
  bookingId: 'bk-1',
  bookingNumber: 'BK-2026-000001',
  propertyId: 'prop-1',
  propertyName: 'Riverside Villa',
  checkInAt: '2026-09-07T14:00',
  checkOutAt: '2026-09-10T12:00',
  currency: 'USD',
  bookingTotal: 120,
  depositRequired: 60,
  netPaid: 20,
  balance: 100,
  paymentStatus: 'partial',
};

const NEW_BOOKING: OcrBookingSelection = {
  type: 'new',
  propertyId: 'prop-2',
  propertyName: 'Beach House',
  checkInAt: '2026-09-07T14:00',
  checkOutAt: '2026-09-09T12:00',
  currency: 'USD',
  calculatedPrice: 200,
  finalPrice: null,
  priceOverrideReason: '',
  conflictOverride: false,
  conflictOverrideReason: '',
  note: '',
};

test('customer selection moves the flow to the booking step only once one is chosen', () => {
  let state = ocrFlowReducer(freshState(), { type: 'CONTINUE_CUSTOMER' });
  assert.equal(state.step, 'source', 'no customer yet — nothing to continue to');

  state = ocrFlowReducer(state, {
    type: 'SELECT_CUSTOMER',
    customer: { type: 'existing', customerId: 'cust-1', fullName: 'Sok Dara' },
  });
  state = ocrFlowReducer(state, { type: 'CONTINUE_CUSTOMER' });
  assert.equal(state.step, 'booking');
});

test('booking selection moves the flow to confirmation only once one is chosen', () => {
  let state = ocrFlowReducer(freshState(), { type: 'CONTINUE_BOOKING' });
  assert.equal(state.step, 'source', 'no booking yet — nothing to continue to');

  state = ocrFlowReducer(state, { type: 'SELECT_BOOKING', booking: EXISTING_BOOKING });
  state = ocrFlowReducer(state, { type: 'CONTINUE_BOOKING' });
  assert.equal(state.step, 'confirmation');
});

test('back navigation walks customer -> booking -> confirmation and back again', () => {
  let state = ocrFlowReducer(freshState(), {
    type: 'SELECT_CUSTOMER',
    customer: { type: 'existing', customerId: 'cust-1', fullName: 'Sok Dara' },
  });
  state = ocrFlowReducer(state, { type: 'CONTINUE_CUSTOMER' });
  state = ocrFlowReducer(state, { type: 'SELECT_BOOKING', booking: NEW_BOOKING });
  state = ocrFlowReducer(state, { type: 'CONTINUE_BOOKING' });
  assert.equal(state.step, 'confirmation');

  state = ocrFlowReducer(state, { type: 'BACK' });
  assert.equal(state.step, 'booking');
  assert.deepEqual(state.booking, NEW_BOOKING, 'going back must not lose the chosen booking');

  state = ocrFlowReducer(state, { type: 'BACK' });
  assert.equal(state.step, 'customer');
});

test('new customer creation carries the typed name and phone into the payload', () => {
  let state = ocrFlowReducer(freshState(), {
    type: 'SELECT_CUSTOMER',
    customer: { type: 'new', fullName: 'Chan Thavy', phone: '+85512345678' },
  });
  state = ocrFlowReducer(state, { type: 'CONTINUE_CUSTOMER' });
  state = ocrFlowReducer(state, { type: 'SELECT_BOOKING', booking: NEW_BOOKING });
  state = ocrFlowReducer(state, { type: 'CONTINUE_BOOKING' });

  const payload = buildConfirmationPayload(state);
  assert.ok(payload);
  assert.deepEqual(payload?.customer, {
    type: 'new',
    fullName: 'Chan Thavy',
    phone: '+85512345678',
  });
  assert.deepEqual(payload?.booking, NEW_BOOKING);
});

test('duplicate warning rides along into the confirmation payload untouched', () => {
  let state = ocrFlowReducer(freshState(), {
    type: 'OCR_SUCCEEDED',
    extraction: parseReceiptText(ABA_RECEIPT),
    duplicates: [DUPLICATE],
    possibleDuplicate: true,
  });
  state = ocrFlowReducer(state, { type: 'CONTINUE_REVIEW' });
  state = ocrFlowReducer(state, {
    type: 'SELECT_CUSTOMER',
    customer: { type: 'existing', customerId: 'cust-1', fullName: 'Sok Dara' },
  });
  state = ocrFlowReducer(state, { type: 'CONTINUE_CUSTOMER' });
  state = ocrFlowReducer(state, { type: 'SELECT_BOOKING', booking: EXISTING_BOOKING });
  state = ocrFlowReducer(state, { type: 'CONTINUE_BOOKING' });

  const payload = buildConfirmationPayload(state);
  assert.equal(payload?.possibleDuplicate, true);
  assert.deepEqual(payload?.duplicates, [DUPLICATE]);
});

test('missing fields: a provider failure still produces a reviewable (empty) state', () => {
  const state = ocrFlowReducer(freshState(), {
    type: 'OCR_SUCCEEDED',
    extraction: buildProviderFailureResult(),
    duplicates: [],
    possibleDuplicate: false,
  });
  assert.equal(state.step, 'review');
  assert.equal(state.values.amount, '');
  assert.equal(state.values.method, '');
});

test('restart clears everything back to a fresh business-scoped state', () => {
  let state = ocrFlowReducer(freshState(), { type: 'SKIP_TO_MANUAL' });
  state = ocrFlowReducer(state, { type: 'FIELD_CHANGED', field: 'amount', value: '50' });
  state = ocrFlowReducer(state, { type: 'RESTART' });
  assert.equal(state.step, 'source');
  assert.equal(state.values.amount, '');
  assert.equal(state.businessId, 'biz-1');
});

// --- mobile and web form validation (shared schema) --------------------------

function validPayload() {
  return {
    payerName: 'Sok Dara',
    receiverName: '',
    amount: '150',
    currency: 'USD',
    reference: 'FT23219876543',
    paymentDate: '2026-08-21',
    paymentTime: '14:32',
    method: 'aba',
    methodLabel: 'ABA',
    customerId: 'a5c95f4a-8a2d-4c0b-9d1a-7f6b1b0c2e11',
    newCustomerName: '',
    newCustomerPhone: '',
  };
}

test('ocrReviewSchema accepts a fully corrected, customer-matched payload', () => {
  const result = ocrReviewSchema.safeParse(validPayload());
  assert.equal(result.success, true);
});

test('ocrReviewSchema rejects a zero or missing amount', () => {
  assert.equal(ocrReviewSchema.safeParse({ ...validPayload(), amount: '0' }).success, false);
  assert.equal(ocrReviewSchema.safeParse({ ...validPayload(), amount: '' }).success, false);
});

test('ocrReviewSchema requires a valid currency and payment method', () => {
  assert.equal(ocrReviewSchema.safeParse({ ...validPayload(), currency: '' }).success, false);
  assert.equal(ocrReviewSchema.safeParse({ ...validPayload(), method: '' }).success, false);
});

test('ocrReviewSchema requires a payment date in YYYY-MM-DD', () => {
  assert.equal(ocrReviewSchema.safeParse({ ...validPayload(), paymentDate: '' }).success, false);
  assert.equal(
    ocrReviewSchema.safeParse({ ...validPayload(), paymentDate: '21/08/2026' }).success,
    false,
  );
});

test('ocrReviewSchema requires either an existing or a new customer, never neither', () => {
  const neither = { ...validPayload(), customerId: '', newCustomerName: '', newCustomerPhone: '' };
  assert.equal(ocrReviewSchema.safeParse(neither).success, false);

  const newOnly = {
    ...validPayload(),
    customerId: '',
    newCustomerName: 'Chan Thavy',
    newCustomerPhone: '+85512345678',
  };
  assert.equal(ocrReviewSchema.safeParse(newOnly).success, true);
});

test('ocrReviewSchema allows transaction id and payer name to be blank', () => {
  const result = ocrReviewSchema.safeParse({ ...validPayload(), reference: '', payerName: '' });
  assert.equal(result.success, true);
});

// --- ocrBookingSchema (Phase 6C) ---------------------------------------------

test('ocrBookingSchema accepts an existing-booking selection by id alone', () => {
  const result = ocrBookingSchema.safeParse({
    mode: 'existing',
    bookingId: 'a5c95f4a-8a2d-4c0b-9d1a-7f6b1b0c2e11',
  });
  assert.equal(result.success, true);
});

test('ocrBookingSchema requires dates that end after they start for a new booking', () => {
  const base = {
    mode: 'new' as const,
    propertyId: 'a5c95f4a-8a2d-4c0b-9d1a-7f6b1b0c2e11',
    checkInAt: '2026-09-10T14:00',
    checkOutAt: '2026-09-10T14:00',
    finalPrice: '',
    priceOverrideReason: '',
    conflictOverride: false,
    conflictOverrideReason: '',
    note: '',
  };
  assert.equal(ocrBookingSchema.safeParse(base).success, false);
  assert.equal(
    ocrBookingSchema.safeParse({ ...base, checkOutAt: '2026-09-12T12:00' }).success,
    true,
  );
});

test('ocrBookingSchema requires a reason whenever the price or a conflict is overridden', () => {
  const base = {
    mode: 'new' as const,
    propertyId: 'a5c95f4a-8a2d-4c0b-9d1a-7f6b1b0c2e11',
    checkInAt: '2026-09-10T14:00',
    checkOutAt: '2026-09-12T12:00',
    finalPrice: '',
    priceOverrideReason: '',
    conflictOverride: false,
    conflictOverrideReason: '',
    note: '',
  };
  assert.equal(ocrBookingSchema.safeParse({ ...base, finalPrice: '100' }).success, false);
  assert.equal(
    ocrBookingSchema.safeParse({ ...base, finalPrice: '100', priceOverrideReason: 'VIP rate' })
      .success,
    true,
  );
  assert.equal(ocrBookingSchema.safeParse({ ...base, conflictOverride: true }).success, false);
  assert.equal(
    ocrBookingSchema.safeParse({
      ...base,
      conflictOverride: true,
      conflictOverrideReason: 'guest agreed to move',
    }).success,
    true,
  );
});
