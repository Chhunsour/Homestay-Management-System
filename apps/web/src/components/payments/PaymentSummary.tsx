'use client';

import {
  BOOKING_PAYMENT_COLORS,
  bookingPaymentStatusKey,
  formatMoney,
} from '@homestay/shared';
import type { BookingPaymentSummary } from '@homestay/shared';
import { StatusChip } from '@/components/bookings/StatusChip';
import { useT } from '@/components/LocaleProvider';
import { DataRow } from '@/components/ui';

/**
 * What a booking owes, straight from `booking_payment_summary()`. Nothing here
 * recomputes anything — the database is the one place the arithmetic lives.
 */
export function PaymentSummary({ summary }: { summary: BookingPaymentSummary }) {
  const { locale, t } = useT();
  const money = (value: number | string) => formatMoney(locale, Number(value), summary.currency);
  const balance = Number(summary.balance);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5">
        <h2 className="text-sm font-semibold text-slate-900">{t('payment.summary.title')}</h2>
        <PaymentStatusChip status={summary.payment_status} />
      </div>

      {/* The one line an owner reads before answering a guest. */}
      <p className="border-t border-slate-100 bg-slate-50 px-5 py-3 text-sm text-slate-700">
        {balance > 0 ? t('payment.summary.due', { amount: money(balance) }) : t('payment.summary.settled')}
        <span className="ml-2 text-slate-500">
          {t('payment.summary.percent', { percent: String(Math.round(Number(summary.paid_percent))) })}
        </span>
      </p>

      <dl className="border-t border-slate-100">
        <DataRow label={t('payment.summary.total')} value={money(summary.booking_total)} />
        <DataRow label={t('payment.summary.deposit')} value={money(summary.deposit_required)} />
        <DataRow label={t('payment.summary.paid')} value={money(summary.total_paid)} />
        {Number(summary.refund_total) > 0 ? (
          <DataRow label={t('payment.summary.refunded')} value={`− ${money(summary.refund_total)}`} />
        ) : null}
        <DataRow label={t('payment.summary.net')} value={money(summary.net_paid)} />
        <DataRow label={t('payment.summary.balance')} value={money(balance)} />
      </dl>
    </>
  );
}

export function PaymentStatusChip({ status }: { status: BookingPaymentSummary['payment_status'] }) {
  const { t } = useT();
  // Same chip as booking statuses, so a coloured dot means the same thing everywhere.
  return <StatusChip label={t(bookingPaymentStatusKey(status))} color={BOOKING_PAYMENT_COLORS[status]} />;
}
