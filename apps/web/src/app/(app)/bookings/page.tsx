import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  can,
  createTranslator,
  finalPrice,
  formatDateTime,
  formatMoney,
  isBookingFilter,
  isPendingExpired,
  statusLabel,
} from '@homestay/shared';
import type { BookingFilter } from '@homestay/shared';
import { PageHeader, Panel, buttonStyles } from '@/components/ui';
import { StatusChip } from '@/components/bookings/StatusChip';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { listBookableProperties, listBookingStatuses, listBookings } from '@/lib/bookings';

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    filter?: string;
    propertyId?: string;
    statusId?: string;
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
  const filter: BookingFilter = isBookingFilter(params.filter) ? params.filter : 'upcoming';
  const search = params.q?.trim() ?? '';
  const page = Math.max(1, Number(params.page) || 1);
  const propertyId = params.propertyId ?? '';
  const statusId = params.statusId ?? '';
  const from = params.from ?? '';
  const to = params.to ?? '';

  const [{ bookings, hasMore }, properties, statuses] = await Promise.all([
    listBookings(context, { search, filter, propertyId, statusId, from, to, page }),
    listBookableProperties(context),
    listBookingStatuses(context),
  ]);

  const canCreate = can(context.role, 'bookings.manage');
  const canManageStatuses = can(context.role, 'bookings.statuses.manage');
  const now = new Date();

  const query = (overrides: Record<string, string>) =>
    new URLSearchParams({
      filter,
      ...(search ? { q: search } : {}),
      ...(propertyId ? { propertyId } : {}),
      ...(statusId ? { statusId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...overrides,
    }).toString();

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title={t('booking.title')} description={t('booking.subtitle')} />
        <div className="flex flex-wrap items-center gap-2">
          {canManageStatuses ? (
            <Link href="/bookings/statuses" className={buttonStyles('secondary')}>
              {t('status.title')}
            </Link>
          ) : null}
          {canCreate ? (
            <Link href="/bookings/new" className={buttonStyles()}>
              {t('booking.new')}
            </Link>
          ) : null}
        </div>
      </div>

      {/* A plain GET form: the query string is the state, so a filtered list is
          shareable and the back button works. */}
      <form method="get" className="mb-5 flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <label htmlFor="q" className="sr-only">
            {t('booking.search')}
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={search}
            placeholder={t('booking.search')}
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
            <option value="upcoming">{t('booking.filter.upcoming')}</option>
            <option value="today">{t('booking.filter.today')}</option>
            <option value="expired">{t('booking.filter.expired')}</option>
            <option value="all">{t('common.all')}</option>
          </select>
        </div>
        <div>
          <label htmlFor="propertyId" className="sr-only">
            {t('booking.property')}
          </label>
          <select
            id="propertyId"
            name="propertyId"
            defaultValue={propertyId}
            className="block rounded-sm border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
          >
            <option value="">{t('calendar.allProperties')}</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="statusId" className="sr-only">
            {t('booking.status')}
          </label>
          <select
            id="statusId"
            name="statusId"
            defaultValue={statusId}
            className="block rounded-sm border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
          >
            <option value="">{t('common.all')}</option>
            {statuses.map((status) => (
              <option key={status.id} value={status.id}>
                {statusLabel(status, t)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="from" className="mb-1 block text-xs text-slate-600">
            {t('booking.filter.from')}
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={from}
            className="block rounded-sm border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
          />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-xs text-slate-600">
            {t('booking.filter.to')}
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={to}
            className="block rounded-sm border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
          />
        </div>
        <button type="submit" className={buttonStyles('secondary')}>
          {t('common.search')}
        </button>
      </form>

      {bookings.length === 0 ? (
        <div className="panel px-6 py-12 text-center">
          <p className="text-base font-medium text-slate-900">{t('booking.empty.title')}</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
            {search || filter !== 'upcoming' || propertyId || statusId || from || to
              ? t('booking.empty.filtered')
              : t('booking.empty.body')}
          </p>
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-600">
            {t('booking.count', { count: String(bookings.length) })}
          </p>
          <Panel className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-600">
                <tr>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('booking.number')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('booking.property')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('booking.customer')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('booking.checkIn')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('booking.checkOut')}
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    {t('booking.status')}
                  </th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">
                    {t('booking.price')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((booking) => (
                  <tr key={booking.id} className="border-b border-slate-100 last:border-b-0">
                    <td className="px-5 py-3">
                      <Link
                        href={`/bookings/${booking.id}`}
                        className="font-medium text-brand-800 hover:underline"
                      >
                        {booking.booking_number}
                      </Link>
                      {booking.conflict_override ? (
                        <span className="ml-2 inline-flex rounded-sm bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-amber-200 ring-inset">
                          {t('booking.conflict.badge')}
                        </span>
                      ) : null}
                      {isPendingExpired(booking, now) ? (
                        <span className="ml-2 inline-flex rounded-sm bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-900 ring-1 ring-rose-200 ring-inset">
                          {t('booking.pending.expired')}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 text-slate-700">
                      {booking.property?.name ?? t('common.notSet')}
                    </td>
                    <td className="px-5 py-3 text-slate-700">
                      {booking.customer ? (
                        <Link href={`/guests/${booking.customer.id}`} className="hover:underline">
                          {booking.customer.full_name}
                        </Link>
                      ) : (
                        t('common.notSet')
                      )}
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {formatDateTime(locale, booking.check_in_at, context.timezone)}
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {formatDateTime(locale, booking.check_out_at, context.timezone)}
                    </td>
                    <td className="px-5 py-3">
                      {booking.status ? (
                        <StatusChip
                          label={statusLabel(booking.status, t)}
                          color={booking.status.color}
                        />
                      ) : null}
                    </td>
                    <td className="px-5 py-3 text-right text-slate-700">
                      {formatMoney(locale, finalPrice(booking), booking.currency)}
                      {booking.price_overridden ? (
                        <span className="ml-2 text-xs text-slate-500">
                          {t('booking.price.override.badge')}
                        </span>
                      ) : null}
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
                href={`/bookings?${query({ page: String(page + 1) })}`}
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
