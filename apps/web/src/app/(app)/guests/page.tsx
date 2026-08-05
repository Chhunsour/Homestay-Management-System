import Link from 'next/link';
import { redirect } from 'next/navigation';
import { can, createTranslator, isCustomerFilter } from '@homestay/shared';
import type { CustomerFilter } from '@homestay/shared';
import { PageHeader, Panel, buttonStyles } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { listCustomers } from '@/lib/customers';

function toFilter(value: string | undefined): CustomerFilter {
  return isCustomerFilter(value) ? value : 'active';
}

export default async function GuestsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string; page?: string }>;
}) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const locale = await getLocale();
  const t = createTranslator(locale);
  const { q, filter: filterParam, page: pageParam } = await searchParams;
  const filter = toFilter(filterParam);
  const search = q?.trim() ?? '';
  const page = Math.max(1, Number(pageParam) || 1);

  const { customers, hasMore } = await listCustomers(context, { search, filter, page });
  const canArchive = can(context.role, 'customers.archive');
  const canImport = can(context.role, 'customers.import');
  const canExport = can(context.role, 'customers.export');

  const query = (overrides: Record<string, string>) =>
    new URLSearchParams({ filter, ...(search ? { q: search } : {}), ...overrides }).toString();

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title={t('customer.title')} description={t('customer.subtitle')} />
        <div className="flex flex-wrap items-center gap-2">
          {canImport ? (
            <Link href="/guests/import" className={buttonStyles('secondary')}>
              {t('customer.import.title')}
            </Link>
          ) : null}
          {canExport ? (
            // A plain link, not an action: the response is a file download.
            <a href={`/guests/export?${query({})}`} className={buttonStyles('secondary')}>
              {t('customer.export.button')}
            </a>
          ) : null}
          <Link href="/guests/new" className={buttonStyles()}>
            {t('customer.new')}
          </Link>
        </div>
      </div>

      {canArchive ? null : (
        <p className="mb-5 rounded-sm border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {t('customer.readOnly')}
        </p>
      )}

      {/* A plain GET form: the query string is the state, so results are
          shareable and the back button works. */}
      <form method="get" className="mb-5 flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <label htmlFor="q" className="sr-only">
            {t('customer.search')}
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={search}
            placeholder={t('customer.search')}
            className="block w-full rounded-sm border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
          />
        </div>
        <div>
          <label htmlFor="filter" className="sr-only">
            {t('common.all')}
          </label>
          <select
            id="filter"
            name="filter"
            defaultValue={filter}
            className="block rounded-sm border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
          >
            <option value="active">{t('customer.filter.active')}</option>
            <option value="archived">{t('customer.filter.archived')}</option>
            <option value="all">{t('common.all')}</option>
          </select>
        </div>
        <button type="submit" className={buttonStyles('secondary')}>
          {t('common.search')}
        </button>
      </form>

      {customers.length === 0 ? (
        <div className="panel px-6 py-12 text-center">
          <p className="text-base font-medium text-slate-900">{t('customer.empty.title')}</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
            {search || filter !== 'active'
              ? t('customer.empty.filtered')
              : t('customer.empty.body')}
          </p>
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-600">
            {t('customer.count', { count: String(customers.length) })}
          </p>
          <Panel className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-600">
                <tr>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('customer.field.fullName')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('customer.field.phone')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('customer.field.facebookName')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('customer.status.active')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-5 py-3">
                      <Link
                        href={`/guests/${customer.id}`}
                        className="font-medium text-brand-800 hover:underline"
                      >
                        {customer.full_name}
                      </Link>
                    </td>
                    {/* Dialling is what staff do with this column all day. */}
                    <td className="px-5 py-3 text-slate-700">
                      <a href={`tel:${customer.normalized_phone}`} className="hover:underline">
                        {customer.phone}
                      </a>
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {customer.facebook_name || customer.telegram_username || t('common.notSet')}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={
                          customer.archived_at
                            ? 'inline-flex rounded-sm bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200 ring-inset'
                            : 'inline-flex rounded-sm bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 ring-inset'
                        }
                      >
                        {customer.archived_at
                          ? t('customer.status.archived')
                          : t('customer.status.active')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          {hasMore ? (
            <div className="mt-4 text-center">
              {/* Rows accumulate rather than paging away: staff scan this list,
                  they do not navigate it. */}
              <Link
                href={`/guests?${query({ page: String(page + 1) })}`}
                className={buttonStyles('secondary')}
              >
                {t('customer.more')}
              </Link>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
