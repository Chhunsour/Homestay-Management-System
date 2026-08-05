import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  createTranslator,
  formatDateTime,
  formatMoney,
  paymentMethodKey,
  paymentStatusKey,
  paymentTypeKey,
} from '@homestay/shared';
import { PaymentActions } from '@/components/payments/PaymentActions';
import { ProofManager } from '@/components/payments/ProofManager';
import { DataRow, PageHeader, Panel } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { getPayment, signedProofUrls } from '@/lib/payments';

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const { id } = await params;
  const locale = await getLocale();
  const t = createTranslator(locale);

  const payment = await getPayment(context, id);
  if (!payment) notFound();

  const urls = await signedProofUrls(payment.proofs.map((proof) => proof.storage_path));
  const money = (value: number | string) =>
    formatMoney(locale, Number(value), payment.currency);

  // What is left to refund: the original less every refund already linked to it.
  const refunded = payment.adjustments
    .filter((adjustment) => adjustment.action === 'refund')
    .reduce((sum, adjustment) => sum + Number(adjustment.corrected_amount ?? 0), 0);
  const refundable = Math.max(Number(payment.amount) - refunded, 0);

  return (
    <>
      <PageHeader
        title={t('payment.detail.title', { number: payment.payment_number })}
        description={payment.booking?.booking_number ?? undefined}
      />

      {payment.status === 'voided' ? (
        <p className="mb-5 rounded-sm border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {t('payment.error.voided')}
        </p>
      ) : null}
      {payment.duplicate_override || payment.overpayment_override ? (
        <p className="mb-5 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {payment.overpayment_override
            ? t('payment.overpayment.title')
            : t('payment.duplicate.title')}
          {payment.override_reason ? ` — ${payment.override_reason}` : ''}
        </p>
      ) : null}

      <div className="space-y-6">
        <Panel>
          <div className="px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('payment.title')}</h2>
          </div>
          <dl className="border-t border-slate-100">
            <DataRow label={t('payment.number')} value={payment.payment_number} />
            <DataRow label={t('payment.amount')} value={money(payment.amount)} />
            <DataRow label={t('payment.method')} value={t(paymentMethodKey(payment.method))} />
            <DataRow label={t('payment.type')} value={t(paymentTypeKey(payment.payment_type))} />
            <DataRow label={t('payment.status')} value={t(paymentStatusKey(payment.status))} />
            <DataRow
              label={t('payment.date')}
              value={formatDateTime(locale, payment.paid_at, context.timezone)}
            />
            <DataRow
              label={t('payment.reference')}
              value={payment.reference || t('common.notSet')}
            />
            <DataRow label={t('payment.payer')} value={payment.payer_name || t('common.notSet')} />
            <DataRow label={t('payment.note')} value={payment.note || t('common.notSet')} />
            <DataRow
              label={t('payment.booking')}
              value={
                payment.booking ? (
                  <Link
                    href={`/bookings/${payment.booking.id}`}
                    className="text-brand-800 hover:underline"
                  >
                    {payment.booking.booking_number}
                  </Link>
                ) : (
                  t('common.notSet')
                )
              }
            />
            <DataRow
              label={t('payment.customer')}
              value={
                payment.customer ? (
                  <Link
                    href={`/guests/${payment.customer.id}`}
                    className="text-brand-800 hover:underline"
                  >
                    {payment.customer.full_name} — {payment.customer.phone}
                  </Link>
                ) : (
                  t('common.notSet')
                )
              }
            />
            <DataRow
              label={t('payment.property')}
              value={payment.property?.name ?? t('common.notSet')}
            />
            <DataRow
              label={t('payment.verifiedBy')}
              value={
                payment.verified_at
                  ? formatDateTime(locale, payment.verified_at, context.timezone)
                  : t('payment.verify.pending')
              }
            />
          </dl>
        </Panel>

        <Panel>
          <div className="px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('payment.proof.title')}</h2>
          </div>
          <ProofManager
            paymentId={payment.id}
            bookingId={payment.booking_id}
            proofs={payment.proofs.map((proof) => ({
              ...proof,
              url: urls[proof.storage_path] ?? null,
            }))}
            // Whoever may record a payment may attach the screenshot for it.
            canUpload={payment.status !== 'voided'}
          />
        </Panel>

        {payment.adjustments.length > 0 ? (
          <Panel>
            <div className="px-5 py-3.5">
              <h2 className="text-sm font-semibold text-slate-900">
                {t('payment.adjustments.title')}
              </h2>
            </div>
            <ul className="border-t border-slate-100">
              {payment.adjustments.map((adjustment) => (
                <li
                  key={adjustment.id}
                  className="border-b border-slate-100 px-5 py-3 text-sm last:border-b-0"
                >
                  <p className="font-medium text-slate-900">
                    {t(`payment.adjustment.${adjustment.action}` as 'payment.adjustment.void')}
                    <span className="ml-2 font-normal text-slate-500">
                      {formatDateTime(locale, adjustment.created_at, context.timezone)}
                    </span>
                  </p>
                  {adjustment.action === 'correct' && adjustment.corrected_amount !== null ? (
                    <p className="text-slate-700">
                      {t('payment.adjustment.change', {
                        from: money(adjustment.original_amount),
                        to: money(adjustment.corrected_amount),
                      })}
                    </p>
                  ) : null}
                  {adjustment.action === 'refund' ? (
                    <p className="text-slate-700">{money(adjustment.corrected_amount ?? 0)}</p>
                  ) : null}
                  <p className="text-slate-600">{adjustment.reason}</p>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        <Panel>
          <PaymentActions payment={payment} role={context.role} refundable={refundable} />
        </Panel>
      </div>
    </>
  );
}
