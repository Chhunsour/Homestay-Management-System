import { DEPOSIT_PERCENT, PAYMENT_DUPLICATE_MINUTES } from './constants.ts';
import type { BookingPaymentStatus, Currency, PaymentMethod } from './constants.ts';
import type { Role } from './roles.ts';
import { can } from './roles.ts';
import type { PostgrestErrorLike } from './bookings.ts';
import type {
  BookingPaymentSummary,
  Payment,
  PaymentDuplicate,
  PaymentProof,
} from './types.ts';
import type { TranslationKey } from './i18n/en.ts';

/**
 * Money maths for bookings. Pure, like `bookings.ts`: rows in, numbers out.
 *
 * Every figure here is derived from the payment rows on the fly. There is no
 * balance column in the database and there must never be one — a stored
 * balance is a number that silently disagrees with the payments beneath it the
 * first time anything goes wrong.
 *
 * This file is the mirror of `public.booking_payment_summary()`. The database
 * is the authority (the client cannot be trusted with what a guest owes); this
 * copy exists so a screen can show the new total the instant an amount is
 * typed, before anything is saved. `payments.test.ts` pins the two together by
 * walking the same ladder of cases.
 */

// --- rounding ---------------------------------------------------------------

/**
 * Two decimal places, the way `numeric(12,2)` does it. Plain `toFixed` on a
 * float gets 1.005 wrong; the epsilon nudge is what keeps 0.1 + 0.2 from
 * costing a guest a cent.
 */
export function round2(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** `numeric` arrives as a number through PostgREST and a string elsewhere. */
function num(value: number | string | null | undefined): number {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : (value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

// --- deposits and balances --------------------------------------------------

/** The standard 50%. Rounded once, here, so nothing rounds it differently. */
export function depositRequired(bookingTotal: number | string): number {
  return round2(num(bookingTotal) * DEPOSIT_PERCENT);
}

/** Rows that still count. Only a voided payment stops counting. */
export function countsTowardBalance(payment: Pick<Payment, 'status'>): boolean {
  return payment.status !== 'voided';
}

export interface PaymentTotals {
  /** Money in: every non-voided, non-refund row. */
  totalPaid: number;
  /** Money back out: every non-voided refund row. */
  refundTotal: number;
  /** What the business is actually holding. */
  netPaid: number;
}

export function sumPayments(
  payments: ReadonlyArray<Pick<Payment, 'amount' | 'status' | 'payment_type'>>,
): PaymentTotals {
  let totalPaid = 0;
  let refundTotal = 0;
  for (const payment of payments) {
    if (!countsTowardBalance(payment)) continue;
    if (payment.payment_type === 'refund') refundTotal += num(payment.amount);
    else totalPaid += num(payment.amount);
  }
  totalPaid = round2(totalPaid);
  refundTotal = round2(refundTotal);
  return { totalPaid, refundTotal, netPaid: round2(totalPaid - refundTotal) };
}

/**
 * The status ladder, in the same order as the SQL `case`. Order matters: a
 * fully-refunded booking reads `refunded`, not `unpaid`, because the two mean
 * very different things to whoever picks up the phone next.
 */
export function bookingPaymentStatus(args: {
  bookingTotal: number;
  totals: PaymentTotals;
}): BookingPaymentStatus {
  const { bookingTotal, totals } = args;
  const net = totals.netPaid;
  if (net <= 0 && totals.refundTotal > 0) return 'refunded';
  if (net <= 0) return 'unpaid';
  if (net > bookingTotal) return 'overpaid';
  if (net >= bookingTotal) return 'paid';
  if (net >= depositRequired(bookingTotal)) return 'deposit_paid';
  return 'partial';
}

/**
 * Everything a screen needs about one booking's money.
 *
 * `balance` floors at zero: an overpayment is reported by the status and by
 * `netPaid`, not as a negative amount owed, because "you owe -$20" is not a
 * sentence anyone should have to read to a guest.
 */
export function summarizeBookingPayments(args: {
  bookingTotal: number | string;
  currency: Currency;
  payments: ReadonlyArray<Pick<Payment, 'amount' | 'status' | 'payment_type'>>;
}): Omit<BookingPaymentSummary, 'booking_id' | 'business_id'> {
  const bookingTotal = round2(num(args.bookingTotal));
  const totals = sumPayments(args.payments);
  return {
    currency: args.currency,
    booking_total: bookingTotal,
    deposit_required: depositRequired(bookingTotal),
    total_paid: totals.totalPaid,
    refund_total: totals.refundTotal,
    net_paid: totals.netPaid,
    balance: round2(Math.max(bookingTotal - totals.netPaid, 0)),
    paid_percent: bookingTotal > 0 ? round2((totals.netPaid / bookingTotal) * 100) : 0,
    payment_status: bookingPaymentStatus({ bookingTotal, totals }),
  };
}

/** Would this new amount take the booking past its total? */
export function isOverpayment(args: {
  summary: Pick<BookingPaymentSummary, 'booking_total' | 'net_paid'>;
  amount: number;
}): boolean {
  return round2(args.summary.net_paid + args.amount) > round2(args.summary.booking_total);
}

/** Does this new amount reach the 50% that confirms a pending booking? */
export function reachesDeposit(args: {
  summary: Pick<BookingPaymentSummary, 'booking_total' | 'net_paid'>;
  amount: number;
}): boolean {
  return round2(args.summary.net_paid + args.amount) >= depositRequired(args.summary.booking_total);
}

// --- duplicate detection ----------------------------------------------------

/**
 * The client-side half of duplicate detection: it warns while the form is
 * still open. The database repeats the reference check inside
 * `record_payment()` and refuses there, so a screen that skips this — or a
 * caller that never had a screen — still cannot save the same transaction id
 * twice.
 */
export function findDuplicates(args: {
  candidate: {
    reference?: string | null;
    amount: number;
    paidAt: Date | string;
    checksum?: string | null;
  };
  payments: ReadonlyArray<Payment & { proofs?: ReadonlyArray<Pick<PaymentProof, 'checksum'>> }>;
}): PaymentDuplicate[] {
  const reference = (args.candidate.reference ?? '').trim().toLowerCase();
  const checksum = (args.candidate.checksum ?? '').trim().toLowerCase();
  const at = new Date(args.candidate.paidAt).getTime();
  const window = PAYMENT_DUPLICATE_MINUTES * 60_000;

  const out: PaymentDuplicate[] = [];
  for (const payment of args.payments) {
    if (payment.status === 'voided') continue;

    const kind: PaymentDuplicate['kind'] | null =
      reference && (payment.reference ?? '').trim().toLowerCase() === reference
        ? 'reference'
        : checksum && (payment.proofs ?? []).some((p) => p.checksum === checksum)
          ? 'file'
          : round2(num(payment.amount)) === round2(args.candidate.amount) &&
              Number.isFinite(at) &&
              Math.abs(new Date(payment.paid_at).getTime() - at) <= window
            ? 'amount'
            : null;

    if (!kind) continue;
    out.push({
      kind,
      id: payment.id,
      payment_number: payment.payment_number,
      amount: num(payment.amount),
      currency: payment.currency,
      paid_at: payment.paid_at,
      reference: payment.reference,
      status: payment.status,
    });
  }
  return out;
}

/** A matching transaction id is the hard block; the rest are only warnings. */
export function isBlockingDuplicate(duplicates: readonly PaymentDuplicate[]): boolean {
  return duplicates.some((duplicate) => duplicate.kind === 'reference');
}

// --- permissions ------------------------------------------------------------

/**
 * Who may push past a warning. Staff never can — not by unchecking a box, not
 * by retrying. The RPC checks the same permission, so this only decides
 * whether the checkbox is drawn at all.
 */
export function canOverridePayment(role: Role | null | undefined): boolean {
  return can(role, 'payments.override');
}

/**
 * Whether a payment can still be changed, and by whom.
 *
 * Voided is terminal. A verified payment is out of reach of anyone who cannot
 * correct — which is the "staff cannot modify verified payments" rule, and
 * since staff cannot correct anything at all, it holds a fortiori.
 */
export function canCorrectPayment(
  role: Role | null | undefined,
  payment: Pick<Payment, 'status'>,
): boolean {
  return payment.status !== 'voided' && can(role, 'payments.correct');
}

export function canRefundPayment(
  role: Role | null | undefined,
  payment: Pick<Payment, 'status' | 'payment_type'>,
): boolean {
  return (
    payment.status !== 'voided' &&
    payment.payment_type !== 'refund' &&
    can(role, 'payments.refund')
  );
}

export function canVoidPayment(
  role: Role | null | undefined,
  payment: Pick<Payment, 'status'>,
): boolean {
  return payment.status !== 'voided' && can(role, 'payments.void');
}

export function canVerifyPayment(
  role: Role | null | undefined,
  payment: Pick<Payment, 'status'>,
): boolean {
  return payment.status === 'recorded' && can(role, 'payments.verify');
}

// --- display ----------------------------------------------------------------

export function paymentMethodKey(method: PaymentMethod): TranslationKey {
  return `payment.method.${method}` as TranslationKey;
}

export function paymentStatusKey(status: Payment['status']): TranslationKey {
  return `payment.status.${status}` as TranslationKey;
}

export function paymentTypeKey(type: Payment['payment_type']): TranslationKey {
  return `payment.type.${type}` as TranslationKey;
}

export function bookingPaymentStatusKey(status: BookingPaymentStatus): TranslationKey {
  return `payment.booking.${status}` as TranslationKey;
}

/** Same palette as `STATUS_COLORS`, so the money badges match the status dots. */
export const BOOKING_PAYMENT_COLORS: Record<BookingPaymentStatus, string> = {
  unpaid: '#b91c1c',
  partial: '#b45309',
  deposit_paid: '#1d4ed8',
  paid: '#047857',
  overpaid: '#7c3aed',
  refunded: '#334155',
};

// --- errors -----------------------------------------------------------------

const PAYMENT_ERROR_KEYS: Record<string, TranslationKey> = {
  auth_required: 'error.unauthorized',
  forbidden: 'error.unauthorized',
  duplicate_payment: 'payment.duplicate.blocked',
  overpayment: 'payment.overpayment.blocked',
  override_reason_required: 'payment.override.reason',
  reason_required: 'payment.reason.required',
  invalid_amount: 'validation.price',
  invalid_payment_type: 'error.generic',
  payment_voided: 'payment.error.voided',
  payment_not_found: 'payment.error.notFound',
  booking_not_found: 'booking.error.notFound',
};

/** Maps a payment RPC failure onto a translation key. Shared by both apps. */
export function paymentErrorKey(error: PostgrestErrorLike): TranslationKey {
  const message = (error.message ?? '').trim();
  for (const [name, key] of Object.entries(PAYMENT_ERROR_KEYS)) {
    if (message === name || message.includes(name)) return key;
  }
  // The partial unique index catches a duplicate reference that raced past the
  // explicit check, and it must read the same to the user.
  if (error.code === '23505') return 'payment.duplicate.blocked';
  return 'error.generic';
}

/** The duplicates a refused write carried in its DETAIL field. */
export function duplicatesFromError(error: PostgrestErrorLike): PaymentDuplicate[] {
  if (!error.details) return [];
  try {
    const parsed: unknown = JSON.parse(error.details);
    return Array.isArray(parsed) ? (parsed as PaymentDuplicate[]) : [];
  } catch {
    return [];
  }
}

export interface OverpaymentDetail {
  booking_total: number;
  net_paid: number;
  amount: number;
  currency: Currency;
}

/** The arithmetic an `overpayment` refusal carried, for the warning dialog. */
export function overpaymentFromError(error: PostgrestErrorLike): OverpaymentDetail | null {
  if (!error.details) return null;
  try {
    const parsed: unknown = JSON.parse(error.details);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const detail = parsed as Record<string, unknown>;
    if (!('booking_total' in detail)) return null;
    return {
      booking_total: num(detail.booking_total as number),
      net_paid: num(detail.net_paid as number),
      amount: num(detail.amount as number),
      currency: detail.currency as Currency,
    };
  } catch {
    return null;
  }
}
