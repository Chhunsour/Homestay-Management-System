import { PROOF_MAX_BYTES, isProofMimeType } from './constants.ts';
import type { Currency, PaymentMethod } from './constants.ts';
import type { PaymentDuplicate } from './types.ts';

/**
 * Phase 6A — payment screenshot OCR.
 *
 * The provider (Claude, in `supabase/functions/ocr-payment-proof`) does one
 * thing: turn an image into raw transcribed text. Everything that turns that
 * text into money — the amount, the reference, who sent it — happens here,
 * in a pure function with no network calls. That split is what makes the
 * provider replaceable and this file testable with plain strings instead of
 * screenshots.
 *
 * Nothing here is trusted financial data. A field is either read with
 * reasonable confidence or it is `null` with a warning — never guessed.
 */

// --- extraction shape --------------------------------------------------------

/** One extracted value plus how sure the parser is. `confidence` is 0 when `value` is null. */
export interface OcrField<T> {
  value: T | null;
  confidence: number;
}

function field<T>(value: T | null, confidence: number): OcrField<T> {
  return { value, confidence: value === null ? 0 : confidence };
}

const EMPTY_FIELDS = [
  'amount',
  'currency',
  'reference',
  'paymentDate',
  'paymentTime',
  'payerName',
] as const;

export const OCR_WARNINGS = [
  'amount_missing',
  'currency_ambiguous',
  'reference_missing',
  'date_missing',
  'time_missing',
  'payer_name_missing',
  'low_overall_confidence',
  'provider_error',
] as const;
export type OcrWarning = (typeof OCR_WARNINGS)[number];

/** Normalized result of reading one payment screenshot, for manual review only. */
export interface OcrExtraction {
  payerName: OcrField<string>;
  /** The business/host account the money went to, when the screenshot shows it. */
  receiverName: OcrField<string>;
  amount: OcrField<number>;
  currency: OcrField<Currency>;
  /** Bank/ABA/KHQR transaction id or reference. */
  reference: OcrField<string>;
  /** `YYYY-MM-DD`. */
  paymentDate: OcrField<string>;
  /** `HH:MM`, 24-hour. */
  paymentTime: OcrField<string>;
  method: OcrField<PaymentMethod>;
  /** The raw bank/app name as printed (e.g. "ACLEDA"), independent of the normalized `method`. */
  methodLabel: OcrField<string>;
  /** Everything the provider transcribed, verbatim. */
  rawText: string;
  /** Mean confidence across the fields that were found, penalized when the amount is missing. */
  overallConfidence: number;
  warnings: OcrWarning[];
  missingFields: string[];
}

// --- server-side error contract ---------------------------------------------

export type OcrErrorKey =
  | 'auth_required'
  | 'forbidden'
  | 'invalid_request'
  | 'invalid_mime_type'
  | 'invalid_file_size'
  | 'proof_not_found'
  | 'rate_limited'
  | 'provider_error';

/** Two requests per business per second, sustained, is comfortably above any real usage. */
export const OCR_BUSINESS_RATE_LIMIT_PER_MINUTE = 20;
export const OCR_USER_RATE_LIMIT_PER_MINUTE = 8;

export function shouldThrottleOcr(recentBusinessCount: number, recentUserCount: number): boolean {
  return (
    recentBusinessCount >= OCR_BUSINESS_RATE_LIMIT_PER_MINUTE ||
    recentUserCount >= OCR_USER_RATE_LIMIT_PER_MINUTE
  );
}

export function validateOcrMimeType(mimeType: string): OcrErrorKey | null {
  return isProofMimeType(mimeType) ? null : 'invalid_mime_type';
}

export function validateOcrFileSize(sizeBytes: number): OcrErrorKey | null {
  return sizeBytes > 0 && sizeBytes <= PROOF_MAX_BYTES ? null : 'invalid_file_size';
}

/** The row shape the edge function reads from `payment_proofs`. */
export interface OcrProofRow {
  id: string;
  business_id: string;
  payment_id: string;
  storage_path: string;
  mime_type: string;
}

/**
 * `payment_proofs` selects are already scoped by RLS
 * (`has_business_permission(business_id, 'payments.manage')`), so a proof
 * belonging to another business simply never comes back — same as
 * `payment_not_found` covering both "missing" and "not visible" everywhere
 * else in this schema. There is nothing further to check here.
 */
export function resolveProofAccess(
  row: OcrProofRow | null,
): { ok: true; row: OcrProofRow } | { ok: false; errorKey: OcrErrorKey } {
  if (!row) return { ok: false, errorKey: 'proof_not_found' };
  return { ok: true, row };
}

export function summarizeOcrDuplicates(matches: PaymentDuplicate[]): {
  possibleDuplicate: boolean;
  count: number;
} {
  return { possibleDuplicate: matches.length > 0, count: matches.length };
}

/** What the response looks like when the provider call itself failed. */
export function buildProviderFailureResult(): OcrExtraction {
  const empty = <T>(): OcrField<T> => ({ value: null, confidence: 0 });
  return {
    payerName: empty(),
    receiverName: empty(),
    amount: empty(),
    currency: empty(),
    reference: empty(),
    paymentDate: empty(),
    paymentTime: empty(),
    method: empty(),
    methodLabel: empty(),
    rawText: '',
    overallConfidence: 0,
    warnings: ['provider_error'],
    missingFields: [...EMPTY_FIELDS],
  };
}

// --- the parser --------------------------------------------------------------

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const AMOUNT_PATTERNS: Array<{ re: RegExp; currency: Currency; confidence: number }> = [
  {
    re: /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/,
    currency: 'USD',
    confidence: 0.9,
  },
  {
    re: /(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s?(?:usd|us\$)\b/i,
    currency: 'USD',
    confidence: 0.8,
  },
  { re: /៛\s?(\d{1,3}(?:,\d{3})*|\d+)/, currency: 'KHR', confidence: 0.9 },
  { re: /(\d{1,3}(?:,\d{3})*|\d+)\s?(?:khr|riel)\b/i, currency: 'KHR', confidence: 0.8 },
];

function extractAmount(text: string): { amount: OcrField<number>; currency: OcrField<Currency> } {
  for (const pattern of AMOUNT_PATTERNS) {
    const match = text.match(pattern.re);
    if (!match) continue;
    const value = Number(match[1]!.replace(/,/g, ''));
    if (Number.isNaN(value) || value <= 0) continue;
    return {
      amount: field(round2(value), pattern.confidence),
      currency: field(pattern.currency, pattern.confidence),
    };
  }
  return { amount: field<number>(null, 0), currency: field<Currency>(null, 0) };
}

// Anchored on a label so a stray "ref" inside unrelated text never matches.
const REFERENCE_RE =
  /(?:trans(?:action)?\.?\s*(?:id|no\.?|number)?|ref(?:erence)?\.?\s*(?:no\.?|number)?|txn\.?\s*(?:id)?|hash)\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9\-_/]{5,39})/i;

function extractReference(text: string): OcrField<string> {
  const match = text.match(REFERENCE_RE);
  return match ? field(match[1]!, 0.85) : field<string>(null, 0);
}

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

function extractDate(text: string): OcrField<string> {
  let match = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (match) return field(`${match[1]}-${match[2]}-${match[3]}`, 0.85);

  match = text.match(
    /\b(\d{1,2})[\s-](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s-](\d{4})\b/i,
  );
  if (match) {
    const month = MONTHS[match[2]!.toLowerCase().slice(0, 3)];
    if (month) return field(`${match[3]}-${month}-${match[1]!.padStart(2, '0')}`, 0.85);
  }

  // Cambodia writes dates DD/MM/YYYY; a 4-digit year disambiguates from MM/DD.
  match = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (match) {
    const day = match[1]!.padStart(2, '0');
    const month = match[2]!.padStart(2, '0');
    return field(`${match[3]}-${month}-${day}`, 0.7);
  }

  return field<string>(null, 0);
}

function extractTime(text: string): OcrField<string> {
  const match = text.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s?(AM|PM|am|pm)?\b/);
  if (!match) return field<string>(null, 0);

  let hour = Number(match[1]!);
  const minute = match[2]!;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23) return field<string>(null, 0);

  return field(`${String(hour).padStart(2, '0')}:${minute}`, meridiem ? 0.8 : 0.65);
}

// Khmer script (U+1780–U+17FF) alongside Latin, so a Khmer-printed name still matches.
const NAME_CHARS = "A-Za-z\\u1780-\\u17FF.,'\\- ";
const PAYER_KEYWORDS = ['from', 'sender', 'payer', 'paid by'];
const RECEIVER_KEYWORDS = ['to', 'receiver', 'beneficiary', 'paid to', 'merchant'];

function extractName(text: string, keywords: string[]): OcrField<string> {
  const re = new RegExp(`^(?:${keywords.join('|')})\\s*[:\\-]?\\s*([${NAME_CHARS}]{2,60})$`, 'i');
  for (const line of text.split('\n')) {
    const match = line.trim().match(re);
    if (!match) continue;
    const value = match[1]!.trim().replace(/\s{2,}/g, ' ');
    if (value.length >= 2 && !/^\d+$/.test(value)) return field(value, 0.75);
  }
  return field<string>(null, 0);
}

const METHOD_PATTERNS: Array<{ re: RegExp; method: PaymentMethod; label?: string }> = [
  { re: /\bkhqr\b/i, method: 'khqr', label: 'KHQR' },
  { re: /\baba\b/i, method: 'aba', label: 'ABA' },
  {
    re: /\b(acleda|wing|pipay|canadia|prince bank|cambodia post bank|vattanac|prasac|sathapana)\b/i,
    method: 'bank_transfer',
  },
  { re: /\b(bank transfer|wire transfer)\b/i, method: 'bank_transfer', label: 'Bank Transfer' },
  { re: /\bcash\b/i, method: 'cash', label: 'Cash' },
];

function extractMethod(text: string): {
  method: OcrField<PaymentMethod>;
  methodLabel: OcrField<string>;
} {
  for (const pattern of METHOD_PATTERNS) {
    const match = text.match(pattern.re);
    if (!match) continue;
    return {
      method: field(pattern.method, 0.8),
      methodLabel: field(pattern.label ?? match[0], 0.8),
    };
  }
  return { method: field<PaymentMethod>(null, 0), methodLabel: field<string>(null, 0) };
}

/**
 * Turn raw OCR text into the normalized extraction. Deterministic and
 * offline — same input, same output, testable without ever calling the
 * provider.
 */
export function parseReceiptText(rawText: string): OcrExtraction {
  const text = rawText.replace(/\r\n/g, '\n');

  const { amount, currency } = extractAmount(text);
  const reference = extractReference(text);
  const paymentDate = extractDate(text);
  const paymentTime = extractTime(text);
  const payerName = extractName(text, PAYER_KEYWORDS);
  const receiverName = extractName(text, RECEIVER_KEYWORDS);
  const { method, methodLabel } = extractMethod(text);

  const warnings: OcrWarning[] = [];
  const missingFields: string[] = [];

  if (amount.value === null) {
    warnings.push('amount_missing');
    missingFields.push('amount');
  } else if (currency.value === null) {
    warnings.push('currency_ambiguous');
    missingFields.push('currency');
  }
  if (reference.value === null) {
    warnings.push('reference_missing');
    missingFields.push('reference');
  }
  if (paymentDate.value === null) {
    warnings.push('date_missing');
    missingFields.push('paymentDate');
  }
  if (paymentTime.value === null) {
    warnings.push('time_missing');
    missingFields.push('paymentTime');
  }
  if (payerName.value === null) {
    warnings.push('payer_name_missing');
    missingFields.push('payerName');
  }

  const present = [amount, currency, reference, paymentDate, paymentTime, payerName, method].filter(
    (f) => f.value !== null,
  );
  let overallConfidence = present.length
    ? round2(present.reduce((sum, f) => sum + f.confidence, 0) / present.length)
    : 0;
  if (amount.value === null) overallConfidence = Math.min(overallConfidence, 0.25);
  if (overallConfidence < 0.4) warnings.push('low_overall_confidence');

  return {
    payerName,
    receiverName,
    amount,
    currency,
    reference,
    paymentDate,
    paymentTime,
    method,
    methodLabel,
    rawText,
    overallConfidence,
    warnings,
    missingFields,
  };
}
