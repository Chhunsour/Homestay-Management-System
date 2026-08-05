import { notFound, redirect } from 'next/navigation';
import {
  bookingPaymentStatusKey,
  createTranslator,
  formatDate,
  formatDateTime,
  formatMoney,
  paymentMethodKey,
} from '@homestay/shared';
import { PrintButton } from '@/components/payments/PrintButton';
import { getBusinessContext } from '@/lib/business';
import { getReceipt } from '@/lib/payments';

/**
 * A printable receipt. Every value comes from `snapshot`, written when the
 * receipt was issued — renaming the property or fixing a guest's phone number
 * next month must not change a receipt somebody is already holding. The
 * language is the one chosen at issue time, not the reader's.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const { id } = await params;
  const receipt = await getReceipt(context, id);
  if (!receipt) notFound();

  const snapshot = receipt.snapshot;
  const locale = receipt.language;
  const t = createTranslator(locale);
  const zone = snapshot.timezone;
  const money = (value: number | null) =>
    value === null ? '—' : formatMoney(locale, Number(value), snapshot.currency);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <article className="panel space-y-6 p-8 print:border-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{snapshot.business_name}</h1>
            {snapshot.business_phone ? (
              <p className="text-sm text-slate-600">{snapshot.business_phone}</p>
            ) : null}
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold text-slate-900">{t('receipt.title')}</p>
            <p className="text-sm text-slate-600">{receipt.receipt_number}</p>
            <p className="text-xs text-slate-500">
              {formatDateTime(locale, receipt.issued_at, zone)}
            </p>
          </div>
        </header>

        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row label={t('booking.number')} value={snapshot.booking_number} />
          <Row label={t('payment.property')} value={snapshot.property_name} />
          <Row label={t('payment.customer')} value={snapshot.customer_name} />
          <Row label={t('customer.field.phone')} value={snapshot.customer_phone ?? '—'} />
          <Row
            label={t('receipt.stay')}
            value={`${formatDate(locale, snapshot.check_in_at, zone)} → ${formatDate(
              locale,
              snapshot.check_out_at,
              zone,
            )}`}
          />
          <Row label={t('receipt.issuedBy')} value={snapshot.issued_by_name} />
        </dl>

        {snapshot.payment_number ? (
          <section className="rounded-sm border border-slate-200">
            <h2 className="border-b border-slate-200 px-4 py-2 text-sm font-semibold text-slate-900">
              {t('payment.title')}
            </h2>
            <dl className="grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2">
              <Row label={t('payment.number')} value={snapshot.payment_number} />
              <Row label={t('payment.amount')} value={money(snapshot.payment_amount)} />
              <Row
                label={t('payment.method')}
                value={snapshot.payment_method ? t(paymentMethodKey(snapshot.payment_method)) : '—'}
              />
              <Row label={t('payment.reference')} value={snapshot.payment_reference ?? '—'} />
              <Row
                label={t('payment.date')}
                value={snapshot.payment_at ? formatDateTime(locale, snapshot.payment_at, zone) : '—'}
              />
            </dl>
          </section>
        ) : null}

        <section className="rounded-sm border border-slate-200">
          <h2 className="border-b border-slate-200 px-4 py-2 text-sm font-semibold text-slate-900">
            {t('payment.summary.title')}
          </h2>
          <dl className="grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2">
            <Row label={t('payment.summary.total')} value={money(snapshot.booking_total)} />
            <Row label={t('payment.summary.deposit')} value={money(snapshot.deposit_required)} />
            <Row label={t('payment.summary.paid')} value={money(snapshot.total_paid)} />
            {Number(snapshot.refund_total) > 0 ? (
              <Row label={t('payment.summary.refunded')} value={money(snapshot.refund_total)} />
            ) : null}
            <Row label={t('payment.summary.net')} value={money(snapshot.net_paid)} />
            <Row label={t('payment.summary.balance')} value={money(snapshot.balance)} />
            <Row
              label={t('payment.status')}
              value={t(bookingPaymentStatusKey(snapshot.payment_status))}
            />
          </dl>
        </section>

        <footer className="space-y-1 border-t border-slate-200 pt-4 text-sm text-slate-600">
          <p>{t('receipt.thanks')}</p>
          <p className="text-xs text-slate-500">{t('receipt.snapshot')}</p>
        </footer>
      </article>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-slate-100 py-1 last:border-b-0">
      <dt className="text-slate-600">{label}</dt>
      <dd className="text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}
