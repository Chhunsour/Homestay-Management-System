import type { BookingPaymentStatus, Currency, PaymentMethod } from './constants.ts';
import type { PaymentDuplicate } from './types.ts';
import type { OcrExtraction, OcrField } from './ocr.ts';

/**
 * Phase 6B — reviewing and correcting what Phase 6A read off a screenshot.
 *
 * Everything here is pure: turning an `OcrExtraction` into editable form
 * state, tracking which fields a human changed, and the state machine that
 * drives the step flow (`source → processing → review → customer → booking →
 * confirmation`) on both apps. Neither app owns this logic twice — a mobile
 * screen and a web page both `useReducer(ocrFlowReducer, ...)` and render
 * whatever `state.step` says, so "retry", "skip to manual entry" and "back
 * without losing what was typed" behave identically and are testable without
 * rendering anything.
 *
 * The reducer itself still writes nothing: `buildConfirmationPayload()`
 * assembles what the confirmation step shows, and the component that renders
 * it is the one that calls the Phase 6C save action once the reviewer taps
 * confirm — see docs/PHASE_6A_OCR.md for the read-only phase this builds on.
 */

// --- review values -----------------------------------------------------------

/**
 * The eight fields a reviewer can see and correct, plain strings throughout —
 * every screen already holds a payment form this way (see
 * `RecordPaymentScreen` on mobile), so amounts, dates and enums stay
 * controlled-input-friendly until the schema coerces them at submit time.
 */
export interface OcrReviewValues {
  payerName: string;
  receiverName: string;
  amount: string;
  currency: Currency | '';
  reference: string;
  paymentDate: string;
  paymentTime: string;
  method: PaymentMethod | '';
  /** Not independently reviewed, but carried along and shown next to `method`. */
  methodLabel: string;
}

export const OCR_REVIEW_FIELDS = [
  'payerName',
  'receiverName',
  'amount',
  'currency',
  'reference',
  'paymentDate',
  'paymentTime',
  'method',
] as const;
export type OcrReviewFieldName = (typeof OCR_REVIEW_FIELDS)[number];

export const EMPTY_REVIEW_VALUES: OcrReviewValues = {
  payerName: '',
  receiverName: '',
  amount: '',
  currency: '',
  reference: '',
  paymentDate: '',
  paymentTime: '',
  method: '',
  methodLabel: '',
};

/** The OCR result, collapsed into the form's starting values. */
export function reviewValuesFromExtraction(extraction: OcrExtraction): OcrReviewValues {
  return {
    payerName: extraction.payerName.value ?? '',
    receiverName: extraction.receiverName.value ?? '',
    amount: extraction.amount.value !== null ? String(extraction.amount.value) : '',
    currency: extraction.currency.value ?? '',
    reference: extraction.reference.value ?? '',
    paymentDate: extraction.paymentDate.value ?? '',
    paymentTime: extraction.paymentTime.value ?? '',
    method: extraction.method.value ?? '',
    methodLabel: extraction.methodLabel.value ?? '',
  };
}

/** Which of the eight fields a reviewer actually changed from what OCR produced. */
export function editedFields(
  original: OcrReviewValues,
  current: OcrReviewValues,
): OcrReviewFieldName[] {
  return OCR_REVIEW_FIELDS.filter((key) => original[key].trim() !== current[key].trim());
}

const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Fields OCR found but isn't confident about — a nudge to double-check, not an error. */
export function lowConfidenceFields(
  extraction: OcrExtraction,
  threshold = LOW_CONFIDENCE_THRESHOLD,
): OcrReviewFieldName[] {
  return OCR_REVIEW_FIELDS.filter((key) => {
    const field = extraction[key] as OcrField<unknown>;
    return field.value !== null && field.confidence < threshold;
  });
}

// --- base64, for the "fresh screenshot, no proof row yet" upload path -------

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64-encodes raw bytes without `Buffer` or `btoa` — neither exists in
 * React Native's JS runtime. One implementation for both apps, since both
 * need it for the same reason: the OCR edge function's inline-upload request
 * body takes `imageBase64`, and only an already-attached proof can skip this
 * (it goes by `proofId` instead — see `supabase/functions/ocr-payment-proof`).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    result += BASE64_CHARS[b0 >> 2];
    result += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    result +=
      b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    result += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
  }
  return result;
}

// --- customer matching --------------------------------------------------------

/**
 * Never a merge decision — a human always picks or types. `existing` carries
 * `fullName` only for display (the confirmation step has no reason to
 * re-fetch the row); `new` is created for real when the reviewer confirms the
 * customer step, same as any other customer creation in this app.
 */
export type OcrCustomerSelection =
  | { type: 'existing'; customerId: string; fullName: string }
  | { type: 'new'; fullName: string; phone: string };

// --- booking selection (Phase 6C) --------------------------------------------

/**
 * Which booking the reviewed payment attaches to. Display fields only —
 * `bookingTotal`/`balance`/etc. are read once at selection time (from
 * `booking_payment_summary()` for an existing booking, from `priceBooking()`
 * for a new one) so the confirmation step can show a summary without holding
 * a reference to the property or booking row itself. The server recomputes
 * every one of these numbers again inside `record_ocr_payment()`; nothing
 * here is trusted, only shown.
 */
export type OcrBookingSelection =
  | {
      type: 'existing';
      bookingId: string;
      bookingNumber: string;
      propertyId: string;
      propertyName: string;
      checkInAt: string;
      checkOutAt: string;
      currency: Currency;
      bookingTotal: number;
      depositRequired: number;
      netPaid: number;
      balance: number;
      paymentStatus: BookingPaymentStatus;
    }
  | {
      type: 'new';
      propertyId: string;
      propertyName: string;
      /** Local `YYYY-MM-DDTHH:MM`, same convention as the booking form. */
      checkInAt: string;
      checkOutAt: string;
      currency: Currency;
      calculatedPrice: number;
      /** Null means "use the calculated price". */
      finalPrice: number | null;
      priceOverrideReason: string;
      conflictOverride: boolean;
      conflictOverrideReason: string;
      note: string;
    };

/** What the confirmation step shows, and what the save action sends. */
export interface OcrConfirmationPayload {
  businessId: string;
  /** Set when OCR ran against an already-uploaded proof; null for a fresh or skipped screenshot. */
  proofId: string | null;
  /** Null when the reviewer skipped straight to manual entry. */
  extraction: OcrExtraction | null;
  values: OcrReviewValues;
  edited: OcrReviewFieldName[];
  customer: OcrCustomerSelection;
  booking: OcrBookingSelection;
  possibleDuplicate: boolean;
  duplicates: PaymentDuplicate[];
}

// --- the flow state machine ---------------------------------------------------

export type OcrFlowStep =
  | 'source'
  | 'processing'
  | 'review'
  | 'customer'
  | 'booking'
  | 'confirmation';

export interface OcrFlowState {
  step: OcrFlowStep;
  businessId: string;
  /** An existing proof's id, once OCR has run against one (picked or re-run). */
  proofId: string | null;
  extraction: OcrExtraction | null;
  /** OCR's own values, frozen at the moment it succeeded — the baseline `editedFields` compares against. */
  original: OcrReviewValues;
  values: OcrReviewValues;
  duplicates: PaymentDuplicate[];
  possibleDuplicate: boolean;
  customer: OcrCustomerSelection | null;
  booking: OcrBookingSelection | null;
  /** True once the reviewer chose to skip OCR and type everything in by hand. */
  manualEntry: boolean;
  /** The last thing that went wrong — an edge-function error key, or 'error.network'. */
  errorKey: string | null;
}

export function initialOcrFlowState(
  businessId: string,
  proofId: string | null = null,
): OcrFlowState {
  return {
    step: 'source',
    businessId,
    proofId,
    extraction: null,
    original: EMPTY_REVIEW_VALUES,
    values: EMPTY_REVIEW_VALUES,
    duplicates: [],
    possibleDuplicate: false,
    customer: null,
    booking: null,
    manualEntry: false,
    errorKey: null,
  };
}

export type OcrFlowAction =
  | { type: 'START_OCR'; proofId?: string | null }
  | {
      type: 'OCR_SUCCEEDED';
      extraction: OcrExtraction;
      duplicates: PaymentDuplicate[];
      possibleDuplicate: boolean;
      proofId?: string | null;
    }
  | { type: 'OCR_FAILED'; errorKey: string }
  | { type: 'SKIP_TO_MANUAL' }
  | { type: 'RETRY' }
  | { type: 'FIELD_CHANGED'; field: OcrReviewFieldName; value: string }
  | { type: 'CONTINUE_REVIEW' }
  | { type: 'SELECT_CUSTOMER'; customer: OcrCustomerSelection }
  | { type: 'CONTINUE_CUSTOMER' }
  | { type: 'SELECT_BOOKING'; booking: OcrBookingSelection | null }
  | { type: 'CONTINUE_BOOKING' }
  | { type: 'BACK' }
  | { type: 'RESTART' };

const STEP_ORDER: OcrFlowStep[] = [
  'source',
  'processing',
  'review',
  'customer',
  'booking',
  'confirmation',
];

export function ocrFlowReducer(state: OcrFlowState, action: OcrFlowAction): OcrFlowState {
  switch (action.type) {
    case 'START_OCR':
      return {
        ...state,
        step: 'processing',
        errorKey: null,
        proofId: action.proofId ?? state.proofId,
      };

    case 'OCR_SUCCEEDED': {
      const values = reviewValuesFromExtraction(action.extraction);
      return {
        ...state,
        step: 'review',
        extraction: action.extraction,
        original: values,
        values,
        duplicates: action.duplicates,
        possibleDuplicate: action.possibleDuplicate,
        proofId: action.proofId ?? state.proofId,
        manualEntry: false,
        errorKey: null,
      };
    }

    // Stays on 'source' rather than a dead-end error screen: retry and manual
    // entry are both offered from the same place a source is chosen.
    case 'OCR_FAILED':
      return { ...state, step: 'source', errorKey: action.errorKey };

    case 'SKIP_TO_MANUAL':
      return {
        ...state,
        step: 'review',
        extraction: null,
        original: EMPTY_REVIEW_VALUES,
        values: EMPTY_REVIEW_VALUES,
        duplicates: [],
        possibleDuplicate: false,
        manualEntry: true,
        errorKey: null,
      };

    case 'RETRY':
      return { ...state, step: 'processing', errorKey: null };

    case 'FIELD_CHANGED':
      return { ...state, values: { ...state.values, [action.field]: action.value } };

    case 'CONTINUE_REVIEW':
      return { ...state, step: 'customer' };

    case 'SELECT_CUSTOMER':
      return { ...state, customer: action.customer };

    case 'CONTINUE_CUSTOMER':
      return state.customer ? { ...state, step: 'booking' } : state;

    case 'SELECT_BOOKING':
      return { ...state, booking: action.booking };

    case 'CONTINUE_BOOKING':
      return state.booking ? { ...state, step: 'confirmation' } : state;

    case 'BACK': {
      const index = STEP_ORDER.indexOf(state.step);
      const previous = STEP_ORDER[Math.max(index - 1, 0)]!;
      // 'processing' has no screen of its own to go back to.
      return { ...state, step: previous === 'processing' ? 'source' : previous, errorKey: null };
    }

    case 'RESTART':
      return initialOcrFlowState(state.businessId);

    default:
      return state;
  }
}

/** Assembles what the confirmation step shows. Null until a customer and a booking are chosen. */
export function buildConfirmationPayload(state: OcrFlowState): OcrConfirmationPayload | null {
  if (!state.customer || !state.booking) return null;
  return {
    businessId: state.businessId,
    proofId: state.proofId,
    extraction: state.extraction,
    values: state.values,
    edited: editedFields(state.original, state.values),
    customer: state.customer,
    booking: state.booking,
    possibleDuplicate: state.possibleDuplicate,
    duplicates: state.duplicates,
  };
}
