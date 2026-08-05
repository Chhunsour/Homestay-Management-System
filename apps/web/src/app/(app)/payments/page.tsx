import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  PAYMENT_FILTERS,
  PAYMENT_METHODS,
  createTranslator,
  formatDateTime,
  formatMoney,
  isPaymentFilter,
  paymentMethodKey,
  paymentStatusKey,
  paymentTypeKey,
} from '@homestay/shared';
import type { PaymentFilter } from '@homestay/shared';
import { PageHeader, Panel, buttonStyles } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { listBookableProperties } from '@/lib/bookings';
import { listPayments } from '@/lib/payments';

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    filter?: string;
    method?: string;
    propertyId?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const locale = await getLocale();
  const t = createTranslator(locale);
  const params = await searchParams;
  const filter: PaymentFilter = isPaymentFilter(params.filter) ? params.filter : 'all';
  const search = params.q?.trim() ?? '';
  const method = params.method ?? '';
  const propertyId = params.propertyId ?? '';
  const from = params.from ?? '';
  const to = params.to ?? '';
  const page = Math.max(1, Number(params.page) || 1);

  const [{ payments, hasMore }, properties] = await Promise.all([
    listPayments(context, { search, filter, method, propertyId, from, to, page }),
    listBookableProperties(context),
  ]);

  const query = (overrides: Record<string, string>) =>
    new URLSearchParams({
      filter,
      ...(search ? { q: search } : {}),
      ...(method ? { method } : {}),
      ...(propertyId ? { propertyId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...overrides,
    }).toString();

  const control =
    'block rounded-sm border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:ring-1 focus:ring-brand-600';

  return (
    <>
      <PageHeader title={t('payment.title')} description={t('payment.subtitle')} />

      {/* A plain GET form: the query string is the state, so a filtered list is
          shareable and the back button works. */}
      <form method="get" className="mb-5 flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <label htmlFor="q" className="sr-only">
            {t('payment.search.placeholder')}
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={search}
            placeholder={t('payment.search.placeholder')}
            className={`${control} w-full placeholder:text-slate-400`}
          />
        </div>
        <div>
          <label htmlFor="filter" className="sr-only">
            {t('payment.status')}
          </label>
          <select id="filter" name="filter" defaultValue={filter} className={control}>
            {PAYMENT_FILTERS.map((value) => (
              <option key={value} value={value}>
                {t(`payment.filter.${value}` as 'payment.filter.all')}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="method" className="sr-only">
            {t('payment.method')}
          </label>
          <select id="method" name="method" defaultValue={method} className={control}>
            <option value="">{t('common.all')}</option>
            {PAYMENT_METHODS.map((value) => (
              <option key={value} value={value}>
                {t(paymentMethodKey(value))}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="propertyId" className="sr-only">
            {t('payment.property')}
          </label>
          <select id="propertyId" name="propertyId" defaultValue={propertyId} className={control}>
            <option value="">{t('calendar.allProperties')}</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="from" className="mb-1 block text-xs text-slate-600">
            {t('payment.filter.from')}
          </label>
          <input id="from" name="from" type="date" defaultValue={from} className={control} />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-xs text-slate-600">
            {t('payment.filter.to')}
          </label>
          <input id="to" name="to" type="date" defaultValue={to} className={control} />
        </div>
        <button type="submit" className={buttonStyles('secondary')}>
          {t('common.search')}
        </button>
      </form>

      {payments.length === 0 ? (
        <div className="panel px-6 py-12 text-center">
          <p className="text-base font-medium text-slate-900">{t('payment.empty.title')}</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">{t('payment.empty.body')}</p>
        </div>
      ) : (
        <>
          <Panel className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-600">
                <tr>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('payment.number')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('payment.booking')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('payment.customer')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('payment.date')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('payment.method')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('payment.status')}
                  </th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">
                    {t('payment.amount')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-5 py-3">
                      <Link
                        href={`/payments/${payment.id}`}
                        className="font-medium text-brand-800 hover:underline"
                      >
                        {payment.payment_number}
                      </Link>
                      <span className="ml-2 text-xs text-slate-500">
                        {t(paymentTypeKey(payment.payment_type))}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-700">
                      {payment.booking ? (
                        <Link href={`/bookings/${payment.booking.id}`} className="hover:underline">
                          {payment.booking.booking_number}
                        </Link>
                      ) : (
                        t('common.notSet')
                      )}
                    </td>
                    <td className="px-5 py-3 text-slate-700">
                      {payment.customer ? (
                        <Link href={`/guests/${payment.customer.id}`} className="hover:underline">
                          {payment.customer.full_name}
                        </Link>
                      ) : (
                        t('common.notSet')
                      )}
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {formatDateTime(locale, payment.paid_at, context.timezone)}
                    </td>
                    <td className="px-5 py-3 text-slate-700">
                      {t(paymentMethodKey(payment.method))}
                      {payment.reference ? (
                        <span className="ml-2 text-xs text-slate-500">{payment.reference}</span>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 text-slate-700">
                      {t(paymentStatusKey(payment.status))}
                    </td>
                    {/* A voided payment stays visible and struck through: it happened,
                        it just stopped counting. */}
                    <td
                      className={`px-5 py-3 text-right ${
                        payment.status === 'voided'
                          ? 'text-slate-400 line-through'
                          : payment.payment_type === 'refund'
                            ? 'text-rose-700'
                            : 'text-slate-800'
                      }`}
                    >
                      {payment.payment_type === 'refund' ? '− ' : ''}
                      {formatMoney(locale, Number(payment.amount), payment.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          {hasMore ? (
            <div className="mt-4 text-center">
              {/* Rows accumulate rather than paging away: staff scan this list. */}
              <Link
                href={`/payments?${query({ page: String(page + 1) })}`}
                className={buttonStyles('secondary')}
              >
                {t('booking.more')}
              </Link>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
