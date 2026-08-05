import {
  PAYMENT_PAGE_SIZE,
  PAYMENT_PROOF_BUCKET,
  customerSearchFilter,
} from '@homestay/shared';
import type {
  BookingPaymentSummary,
  BusinessContext,
  Payment,
  PaymentFilter,
  PaymentWithDetails,
  Receipt,
} from '@homestay/shared';
import { dayRange } from '@/lib/bookings';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Read helpers for the payment screens.
 *
 * Same rules as `lib/bookings.ts`: every query is scoped by `business_id` as
 * well as being behind RLS, and nothing here writes. Balances are never read
 * from a column — they come from `booking_payment_summary()`, which recomputes
 * them from the payment rows on every call.
 */

const PAYMENT_SELECT =
  '*, proofs:payment_proofs(*), adjustments:payment_adjustments(*), ' +
  'booking:bookings(id, booking_number, check_in_at, check_out_at, property:properties(id, name)), ' +
  'customer:customers(id, full_name, phone)';

/** Signed URLs live ten minutes. Long enough to look, short enough to leak badly. */
const SIGNED_URL_TTL = 60 * 10;

/** PostgREST nests the property under the booking; the screens want it flat. */
function flatten(row: unknown): PaymentWithDetails {
  const record = row as PaymentWithDetails & {
    booking?: (PaymentWithDetails['booking'] & { property?: PaymentWithDetails['property'] }) | null;
  };
  return {
    ...record,
    proofs: record.proofs ?? [],
    adjustments: record.adjustments ?? [],
    property: record.booking?.property ?? null,
  };
}

export interface PaymentListOptions {
  search?: string;
  filter?: PaymentFilter;
  method?: string;
  propertyId?: string;
  bookingId?: string;
  from?: string;
  to?: string;
  page?: number;
}

export async function listPayments(
  context: BusinessContext,
  options: PaymentListOptions = {},
): Promise<{ payments: PaymentWithDetails[]; hasMore: boolean }> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('payments')
    .select(
      options.propertyId
        ? PAYMENT_SELECT.replace('booking:bookings(', 'booking:bookings!inner(')
        : PAYMENT_SELECT,
    )
    .eq('business_id', context.business_id)
    .order('paid_at', { ascending: false });

  if (options.filter && options.filter !== 'all') query = query.eq('status', options.filter);
  if (options.method) query = query.eq('method', options.method);
  if (options.bookingId) query = query.eq('booking_id', options.bookingId);
  if (options.propertyId) query = query.eq('booking.property_id', options.propertyId);
  if (options.from) query = query.gte('paid_at', dayRange(options.from, context.timezone).start);
  if (options.to) query = query.lt('paid_at', dayRange(options.to, context.timezone).end);

  const search = options.search?.trim();
  if (search) {
    const ids = await matchingIds(context, search);
    const escaped = search.replace(/[%,()]/g, ' ').trim();
    const parts = [`payment_number.ilike.%${escaped}%`, `reference.ilike.%${escaped}%`];
    if (ids.customers.length) parts.push(`customer_id.in.(${ids.customers.join(',')})`);
    if (ids.bookings.length) parts.push(`booking_id.in.(${ids.bookings.join(',')})`);
    query = query.or(parts.join(','));
  }

  // Page size + 1: one row past the page is how "show more" knows to appear.
  const limit = Math.max(1, options.page ?? 1) * PAYMENT_PAGE_SIZE;
  const { data, error } = await query.range(0, limit);
  if (error) throw new Error(error.message);

  const rows = (data ?? []).map(flatten);
  return { payments: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** Guests and bookings matching the search box, so payments can be found by either. */
async function matchingIds(
  context: BusinessContext,
  search: string,
): Promise<{ customers: string[]; bookings: string[] }> {
  const supabase = await createSupabaseServerClient();
  const escaped = search.replace(/[%,()]/g, ' ').trim();

  const [customers, bookings] = await Promise.all([
    (async () => {
      const orFilter = customerSearchFilter(search);
      if (!orFilter) return [];
      const { data } = await supabase
        .from('customers')
        .select('id')
        .eq('business_id', context.business_id)
        .or(orFilter)
        .limit(50);
      return (data ?? []).map((row) => (row as { id: string }).id);
    })(),
    (async () => {
      if (!escaped) return [];
      const { data } = await supabase
        .from('bookings')
        .select('id')
        .eq('business_id', context.business_id)
        .ilike('booking_number', `%${escaped}%`)
        .limit(50);
      return (data ?? []).map((row) => (row as { id: string }).id);
    })(),
  ]);

  return { customers, bookings };
}

export async function getPayment(
  context: BusinessContext,
  paymentId: string,
): Promise<PaymentWithDetails | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('payments')
    .select(PAYMENT_SELECT)
    .eq('business_id', context.business_id)
    .eq('id', paymentId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? flatten(data) : null;
}

/** Every payment on one booking, oldest first — the history reads as a story. */
export async function listBookingPayments(
  context: BusinessContext,
  bookingId: string,
): Promise<PaymentWithDetails[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('payments')
    .select(PAYMENT_SELECT)
    .eq('business_id', context.business_id)
    .eq('booking_id', bookingId)
    .order('paid_at', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map(flatten);
}

/**
 * What a booking owes. The database recomputes this from the payment rows on
 * every call; there is no balance column to drift.
 */
export async function getBookingPaymentSummary(
  bookingId: string,
): Promise<BookingPaymentSummary | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('booking_payment_summary', {
    p_booking_id: bookingId,
  });

  if (error) throw new Error(error.message);
  const rows = (data ?? []) as BookingPaymentSummary[];
  return rows[0] ?? null;
}

/** Balances for a page of bookings at once, through the RLS-respecting view. */
export async function bookingTotalsFor(
  context: BusinessContext,
  bookingIds: string[],
): Promise<Record<string, { total_paid: number; refund_total: number; booking_total: number }>> {
  if (bookingIds.length === 0) return {};

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('booking_payment_totals')
    .select('booking_id, booking_total, total_paid, refund_total')
    .eq('business_id', context.business_id)
    .in('booking_id', bookingIds);

  // A missing balance must not take a list down.
  if (error) return {};

  const out: Record<string, { total_paid: number; refund_total: number; booking_total: number }> =
    {};
  for (const row of (data ?? []) as Array<{
    booking_id: string;
    booking_total: number;
    total_paid: number;
    refund_total: number;
  }>) {
    out[row.booking_id] = {
      booking_total: Number(row.booking_total),
      total_paid: Number(row.total_paid),
      refund_total: Number(row.refund_total),
    };
  }
  return out;
}

export async function listReceipts(
  context: BusinessContext,
  bookingId: string,
): Promise<Receipt[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('receipts')
    .select('*')
    .eq('business_id', context.business_id)
    .eq('booking_id', bookingId)
    .order('issued_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as Receipt[];
}

export async function getReceipt(
  context: BusinessContext,
  receiptId: string,
): Promise<Receipt | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('receipts')
    .select('*')
    .eq('business_id', context.business_id)
    .eq('id', receiptId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as Receipt) ?? null;
}

/**
 * The bucket is private, so a proof is only ever reachable through a
 * short-lived signed URL minted for a caller that storage RLS already let read
 * the object. A public URL for a payment screenshot would be a bank statement
 * on the open web.
 */
export async function signedProofUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage
    .from(PAYMENT_PROOF_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL);

  if (error) return {};

  const out: Record<string, string> = {};
  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl) out[entry.path] = entry.signedUrl;
  }
  return out;
}

/** Money figures for the dashboard: what is owed, and what came in today. */
export async function paymentDashboard(context: BusinessContext): Promise<{
  unpaid: number;
  awaitingDeposit: number;
  balanceDue: number;
  paidToday: number;
}> {
  const supabase = await createSupabaseServerClient();
  const today = dayRange(
    new Intl.DateTimeFormat('en-CA', { timeZone: context.timezone }).format(new Date()),
    context.timezone,
  );
  const now = new Date().toISOString();

  const [totals, today_] = await Promise.all([
    supabase
      .from('booking_payment_totals')
      .select('booking_id, booking_total, total_paid, refund_total')
      .eq('business_id', context.business_id),
    supabase
      .from('payments')
      .select('amount, payment_type, status')
      .eq('business_id', context.business_id)
      .gte('paid_at', today.start)
      .lt('paid_at', today.end),
  ]);

  // Only bookings that have not finished are worth chasing money for.
  const { data: live } = await supabase
    .from('bookings')
    .select('id')
    .eq('business_id', context.business_id)
    .gte('check_out_at', now);
  const liveIds = new Set((live ?? []).map((row) => (row as { id: string }).id));

  let unpaid = 0;
  let awaitingDeposit = 0;
  let balanceDue = 0;
  for (const row of (totals.data ?? []) as Array<{
    booking_id: string;
    booking_total: number;
    total_paid: number;
    refund_total: number;
  }>) {
    if (!liveIds.has(row.booking_id)) continue;
    const net = Number(row.total_paid) - Number(row.refund_total);
    const total = Number(row.booking_total);
    if (net <= 0) unpaid += 1;
    if (net < total / 2) awaitingDeposit += 1;
    balanceDue += Math.max(total - net, 0);
  }

  let paidToday = 0;
  for (const row of (today_.data ?? []) as Array<Pick<Payment, 'amount' | 'payment_type' | 'status'>>) {
    if (row.status === 'voided') continue;
    paidToday += row.payment_type === 'refund' ? -Number(row.amount) : Number(row.amount);
  }

  return { unpaid, awaitingDeposit, balanceDue, paidToday };
}
