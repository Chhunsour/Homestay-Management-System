import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  buildProviderFailureResult,
  parseReceiptText,
  resolveProofAccess,
  shouldThrottleOcr,
  summarizeOcrDuplicates,
  validateOcrFileSize,
  validateOcrMimeType,
} from './ocr.ts';
import type { PaymentDuplicate } from './types.ts';
import { PROOF_MAX_BYTES } from './constants.ts';

// --- sanitized fixtures — synthetic text, never a real customer screenshot -

const ABA_RECEIPT = `ABA Mobile
Payment Successful
From: SOK DARA
To: HOMESTAY BUSINESS
Amount: $150.00
Transaction ID: FT23219876543
21-Aug-2026 02:32 PM`;

const KHQR_RECEIPT = `KHQR Payment
Paid to: Sunrise Homestay
Amount: ៛400,000
Ref: KHQR20260821001
21/08/2026 09:15 AM`;

test('parses an ABA-style receipt end to end', () => {
  const result = parseReceiptText(ABA_RECEIPT);
  assert.equal(result.amount.value, 150);
  assert.equal(result.currency.value, 'USD');
  assert.equal(result.reference.value, 'FT23219876543');
  assert.equal(result.paymentDate.value, '2026-08-21');
  assert.equal(result.paymentTime.value, '14:32');
  assert.equal(result.payerName.value, 'SOK DARA');
  assert.equal(result.receiverName.value, 'HOMESTAY BUSINESS');
  assert.equal(result.method.value, 'aba');
  assert.equal(result.methodLabel.value, 'ABA');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.missingFields, []);
  assert.ok(result.overallConfidence > 0.7);
});

test('parses a KHQR-style receipt, including a missing payer name', () => {
  const result = parseReceiptText(KHQR_RECEIPT);
  assert.equal(result.amount.value, 400000);
  assert.equal(result.currency.value, 'KHR');
  assert.equal(result.reference.value, 'KHQR20260821001');
  assert.equal(result.paymentDate.value, '2026-08-21');
  assert.equal(result.paymentTime.value, '09:15');
  assert.equal(result.method.value, 'khqr');
  assert.equal(result.receiverName.value, 'Sunrise Homestay');
  // KHQR confirmations typically show the merchant, not the payer's name.
  assert.equal(result.payerName.value, null);
  assert.ok(result.warnings.includes('payer_name_missing'));
  assert.ok(result.missingFields.includes('payerName'));
});

test('recognizes USD and KHR amounts in every documented format', () => {
  const cases: Array<[string, number, 'USD' | 'KHR']> = [
    ['Amount: $100.00', 100, 'USD'],
    ['Amount: 100 USD', 100, 'USD'],
    ['Amount: ៛400,000', 400000, 'KHR'],
    ['Total: 400000 KHR', 400000, 'KHR'],
  ];
  for (const [text, amount, currency] of cases) {
    const result = parseReceiptText(text);
    assert.equal(result.amount.value, amount, `amount for "${text}"`);
    assert.equal(result.currency.value, currency, `currency for "${text}"`);
  }
});

test('handles a receipt with no transaction id instead of guessing one', () => {
  const text = `ABA Mobile
Payment Successful
Amount: $75.50
21-Aug-2026 10:00 AM`;
  const result = parseReceiptText(text);
  assert.equal(result.reference.value, null);
  assert.equal(result.amount.value, 75.5);
  assert.ok(result.warnings.includes('reference_missing'));
  assert.ok(result.missingFields.includes('reference'));
});

test('a low-confidence extraction is flagged rather than trusted', () => {
  const result = parseReceiptText('aba payment received');
  assert.equal(result.amount.value, null);
  assert.ok(result.warnings.includes('amount_missing'));
  assert.ok(result.warnings.includes('low_overall_confidence'));
  assert.ok(result.overallConfidence <= 0.25);
});

test('provider failure returns an all-null result, never a guess', () => {
  const result = buildProviderFailureResult();
  assert.equal(result.rawText, '');
  assert.equal(result.overallConfidence, 0);
  assert.deepEqual(result.warnings, ['provider_error']);
  for (const key of [
    'amount',
    'currency',
    'reference',
    'paymentDate',
    'paymentTime',
    'payerName',
  ] as const) {
    assert.equal(result[key].value, null);
    assert.ok(result.missingFields.includes(key));
  }
});

test('rejects a file type outside the payment-proof allow-list', () => {
  assert.equal(validateOcrMimeType('application/zip'), 'invalid_mime_type');
  assert.equal(validateOcrMimeType('image/gif'), 'invalid_mime_type');
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
    assert.equal(validateOcrMimeType(mime), null);
  }
});

test('rejects an empty or oversized file', () => {
  assert.equal(validateOcrFileSize(0), 'invalid_file_size');
  assert.equal(validateOcrFileSize(PROOF_MAX_BYTES + 1), 'invalid_file_size');
  assert.equal(validateOcrFileSize(PROOF_MAX_BYTES), null);
  assert.equal(validateOcrFileSize(1024), null);
});

test('a proof RLS hides (another business, or missing) resolves the same way', () => {
  const denied = resolveProofAccess(null);
  assert.equal(denied.ok, false);
  assert.equal(!denied.ok && denied.errorKey, 'proof_not_found');

  const row = {
    id: 'proof-1',
    business_id: 'biz-1',
    payment_id: 'pay-1',
    storage_path: 'businesses/biz-1/payments/pay-1/screenshot.jpg',
    mime_type: 'image/jpeg',
  };
  const allowed = resolveProofAccess(row);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.ok && allowed.row.id, 'proof-1');
});

test('flags a possible duplicate without deciding anything', () => {
  const match: PaymentDuplicate = {
    kind: 'reference',
    id: 'pay-1',
    payment_number: 'PM-2026-000001',
    amount: 150,
    currency: 'USD',
    paid_at: '2026-08-21T14:32:00.000Z',
    reference: 'FT23219876543',
    status: 'recorded',
  };
  assert.deepEqual(summarizeOcrDuplicates([]), { possibleDuplicate: false, count: 0 });
  assert.deepEqual(summarizeOcrDuplicates([match]), { possibleDuplicate: true, count: 1 });
});

test('throttles once either the business or the caller crosses its per-minute cap', () => {
  assert.equal(shouldThrottleOcr(0, 0), false);
  assert.equal(shouldThrottleOcr(19, 7), false);
  assert.equal(shouldThrottleOcr(20, 0), true);
  assert.equal(shouldThrottleOcr(0, 8), true);
});
