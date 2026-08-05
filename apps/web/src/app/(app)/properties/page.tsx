import Link from 'next/link';
import { redirect } from 'next/navigation';
import { can, createTranslator, formatMoney } from '@homestay/shared';
import { PageHeader, Panel, buttonStyles } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { coverPhoto, listProperties, signedPhotoUrls, type PropertyFilter } from '@/lib/properties';

const FILTERS: PropertyFilter[] = ['all', 'active', 'inactive'];

function toFilter(value: string | undefined): PropertyFilter {
  return FILTERS.find((filter) => filter === value) ?? 'all';
}

export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string }>;
}) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const locale = await getLocale();
  const t = createTranslator(locale);
  const { q, filter: filterParam } = await searchParams;
  const filter = toFilter(filterParam);
  const search = q?.trim() ?? '';

  const properties = await listProperties(context, { search, filter });
  const covers = properties.map(coverPhoto).filter((photo) => photo !== null);
  const urls = await signedPhotoUrls(covers.map((photo) => photo.storage_path));
  const canManage = can(context.role, 'properties.manage');

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title={t('property.title')} description={t('property.subtitle')} />
        {canManage ? (
          <Link href="/properties/new" className={buttonStyles()}>
            {t('property.new')}
          </Link>
        ) : null}
      </div>

      {/* A plain GET form: the query string is the state, so results are
          shareable and the back button works. */}
      <form method="get" className="mb-5 flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <label htmlFor="q" className="sr-only">
            {t('property.search')}
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={search}
            placeholder={t('property.search')}
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
            <option value="all">{t('common.all')}</option>
            <option value="active">{t('property.filter.active')}</option>
            <option value="inactive">{t('property.filter.inactive')}</option>
          </select>
        </div>
        <button type="submit" className={buttonStyles('secondary')}>
          {t('common.search')}
        </button>
      </form>

      {properties.length === 0 ? (
        <div className="panel px-6 py-12 text-center">
          <p className="text-base font-medium text-slate-900">{t('property.empty.title')}</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
            {search || filter !== 'all' ? t('property.empty.filtered') : t('property.empty.body')}
          </p>
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-600">
            {t('property.count', { count: String(properties.length) })}
          </p>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {properties.map((property) => {
              const cover = coverPhoto(property);
              const url = cover ? urls[cover.storage_path] : undefined;
              return (
                <li key={property.id}>
                  <Panel className="h-full overflow-hidden">
                    <Link href={`/properties/${property.id}`} className="block">
                      <div className="aspect-4/3 bg-slate-100">
                        {/* ponytail: signed, short-lived URLs — next/image would
                            only add a remotePatterns entry to maintain. */}
                        {url ? <img src={url} alt="" className="size-full object-cover" /> : null}
                      </div>
                      <div className="space-y-1 p-4">
                        <div className="flex items-start justify-between gap-2">
                          <h2 className="text-sm font-semibold text-slate-900">{property.name}</h2>
                          <span
                            className={
                              property.is_active
                                ? 'shrink-0 rounded-sm bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 ring-inset'
                                : 'shrink-0 rounded-sm bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200 ring-inset'
                            }
                          >
                            {property.is_active
                              ? t('property.status.active')
                              : t('property.status.inactive')}
                          </span>
                        </div>
                        <p className="truncate text-sm text-slate-600">
                          {property.address || t('common.notSet')}
                        </p>
                        <p className="text-sm text-slate-900">
                          {property.pricing
                            ? `${formatMoney(locale, property.pricing.weekday_price, property.pricing.currency)} ${t('pricing.perNight')}`
                            : t('pricing.missing')}
                        </p>
                      </div>
                    </Link>
                  </Panel>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
