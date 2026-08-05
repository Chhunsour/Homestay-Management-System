import Link from 'next/link';
import {
  can,
  createTranslator,
  formatDateTime,
  formatMoney,
  paymentMethodKey,
  paymentStatusKey,
  paymentTypeKey,
} from '@homestay/shared';
import type { BusinessContext, Locale } from '@homestay/shared';
import { PaymentSummary } from '@/components/payments/PaymentSummary';
import { RecordPaymentForm } from '@/components/payments/RecordPaymentForm';
import { Panel } from '@/components/ui';
import { getBookingPaymentSummary, listBookingPayments, listReceipts } from '@/lib/payments';

/**
 * The money half of a booking: what is owed, what has been paid, and the form
 * for adding the next payment. Rendered inside the booking detail page so an
 * owner answering Messenger never has to leave the booking to record a deposit.
 */
export async function BookingPayments({
  bookingId,
  context,
  locale,
}: {
  bookingId: string;
  context: BusinessContext;
  locale: Locale;
}) {
  const t = createTranslator(locale);
  const [summary, payments, receipts] = await Promise.all([
    getBookingPaymentSummary(bookingId),
    listBookingPayments(context, bookingId),
    listReceipts(context, bookingId),
  ]);
  if (!summary) return null;

  const canRecord = can(context.role, 'payments.manage');

  return (
    <>
      <Panel>
        <PaymentSummary summary={summary} />
        {canRecord ? (
          <RecordPaymentForm bookingId={bookingId} summary={summary} role={context.role} />
        ) : null}
      </Panel>

      <Panel>
        <div className="px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">{t('payment.history.title')}</h2>
        </div>
        {payments.length === 0 ? (
          <p className="border-t border-slate-100 px-5 py-4 text-sm text-slate-600">
            {t('payment.history.empty')}
          </p>
        ) : (
          <ul className="border-t border-slate-100">
            {payments.map((payment) => (
              <li
                key={payment.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-5 py-3 text-sm last:border-b-0"
              >
                <div>
                  <Link
                    href={`/payments/${payment.id}`}
                    className="font-medium text-brand-800 hover:underline"
                  >
                    {payment.payment_number}
                  </Link>
                  <span className="ml-2 text-slate-600">
                    {t(paymentMethodKey(payment.method))} ·{' '}
                    {t(paymentTypeKey(payment.payment_type))} ·{' '}
                    {t(paymentStatusKey(payment.status))}
                  </span>
                  {payment.proofs.length > 0 ? (
                    <span className="ml-2 text-xs text-slate-500">{t('payment.proof.title')}</span>
                  ) : null}
                  <p className="text-xs text-slate-500">
                    {formatDateTime(locale, payment.paid_at, context.timezone)}
                    {payment.reference ? ` · ${payment.reference}` : ''}
                  </p>
                </div>
                <span
                  className={
                    payment.status === 'voided'
                      ? 'text-slate-400 line-through'
                      : payment.payment_type === 'refund'
                        ? 'text-rose-700'
                        : 'font-medium text-slate-900'
                  }
                >
                  {payment.payment_type === 'refund' ? '− ' : ''}
                  {formatMoney(locale, Number(payment.amount), payment.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {receipts.length > 0 ? (
        <Panel>
          <div className="px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('receipt.list')}</h2>
          </div>
          <ul className="border-t border-slate-100">
            {receipts.map((receipt) => (
              <li
                key={receipt.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-5 py-3 text-sm last:border-b-0"
              >
                <Link
                  href={`/receipts/${receipt.id}`}
                  className="font-medium text-brand-800 hover:underline"
                >
                  {receipt.receipt_number}
                </Link>
                <span className="text-slate-600">
                  {formatDateTime(locale, receipt.issued_at, context.timezone)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  );
}
