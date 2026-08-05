import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  addMonths,
  can,
  coversDate,
  createTranslator,
  monthGrid,
  statusLabel,
  weekGrid,
} from '@homestay/shared';
import type { BookingWithDetails } from '@homestay/shared';
import { PageHeader, Panel, buttonStyles } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { listBookableProperties, listCalendarBookings, todayIn } from '@/lib/bookings';

/** `YYYY-MM-DD` shifted by whole days, without pulling in a date library. */
function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; propertyId?: string }>;
}) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const locale = await getLocale();
  const t = createTranslator(locale);
  const params = await searchParams;

  const today = todayIn(context.timezone);
  const week = params.view === 'week';
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? (params.date as string) : today;
  const propertyId = params.propertyId ?? '';

  const days = week ? weekGrid(anchor) : monthGrid(anchor.slice(0, 7));
  const [bookings, properties] = await Promise.all([
    listCalendarBookings(
      context,
      { from: days[0] ?? anchor, to: shiftDays(days[days.length - 1] ?? anchor, 1) },
      propertyId || undefined,
    ),
    listBookableProperties(context),
  ]);

  const link = (overrides: Record<string, string>) =>
    `/calendar?${new URLSearchParams({
      view: week ? 'week' : 'month',
      date: anchor,
      ...(propertyId ? { propertyId } : {}),
      ...overrides,
    }).toString()}`;

  const previous = week ? shiftDays(anchor, -7) : `${addMonths(anchor.slice(0, 7), -1)}-01`;
  const next = week ? shiftDays(anchor, 7) : `${addMonths(anchor.slice(0, 7), 1)}-01`;

  const heading = new Intl.DateTimeFormat(locale === 'km' ? 'km-KH' : 'en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`));

  const weekdayNames = Intl.DateTimeFormat(locale === 'km' ? 'km-KH' : 'en-GB', {
    weekday: 'short',
    timeZone: 'UTC',
  });

  const cancelled = (booking: BookingWithDetails) => booking.status?.code === 'cancelled';
  const visible = bookings.filter((booking) => !cancelled(booking));

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title={t('calendar.title')} description={t('calendar.subtitle')} />
        {can(context.role, 'bookings.manage') ? (
          <Link href="/bookings/new" className={buttonStyles()}>
            {t('booking.new')}
          </Link>
        ) : null}
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href={link({ date: previous })} className={buttonStyles('secondary')}>
            {t('calendar.previous')}
          </Link>
          <Link href={link({ date: today })} className={buttonStyles('secondary')}>
            {t('calendar.today')}
          </Link>
          <Link href={link({ date: next })} className={buttonStyles('secondary')}>
            {t('calendar.next')}
          </Link>
          <h2 className="ml-2 text-sm font-semibold text-slate-900">{heading}</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={link({ view: 'month' })}
            className={buttonStyles(week ? 'secondary' : 'primary')}
          >
            {t('calendar.month')}
          </Link>
          <Link
            href={link({ view: 'week' })}
            className={buttonStyles(week ? 'primary' : 'secondary')}
          >
            {t('calendar.week')}
          </Link>

          {/* A GET form so the chosen property survives navigation and sharing. */}
          <form method="get" className="flex items-center gap-2">
            <input type="hidden" name="view" value={week ? 'week' : 'month'} />
            <input type="hidden" name="date" value={anchor} />
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
            <button type="submit" className={buttonStyles('secondary')}>
              {t('common.search')}
            </button>
          </form>
        </div>
      </div>

      <Panel className="overflow-x-auto">
        <div className="min-w-[44rem]">
          <div className="grid grid-cols-7 border-b border-slate-200 text-xs uppercase text-slate-600">
            {days.slice(0, 7).map((day) => (
              <div key={day} className="px-3 py-2 font-medium">
                {weekdayNames.format(new Date(`${day}T00:00:00Z`))}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const inMonth = week || day.slice(0, 7) === anchor.slice(0, 7);
              const stays = visible.filter((booking) => coversDate(booking, day, context.timezone));
              return (
                <div
                  key={day}
                  className={`border-b border-r border-slate-100 p-2 ${
                    week ? 'min-h-40' : 'min-h-28'
                  } ${inMonth ? '' : 'bg-slate-50'}`}
                >
                  <div
                    className={`mb-1 text-xs font-medium ${
                      day === today ? 'text-brand-800' : 'text-slate-500'
                    }`}
                  >
                    {Number(day.slice(8))}
                  </div>
                  <ul className="space-y-1">
                    {stays.map((booking) => (
                      <li key={booking.id}>
                        <Link
                          href={`/bookings/${booking.id}`}
                          className="block rounded-sm border-l-2 bg-slate-50 px-1.5 py-1 text-xs text-slate-700 hover:bg-slate-100"
                          style={{ borderLeftColor: booking.status?.color ?? '#94a3b8' }}
                          title={`${booking.property?.name ?? ''} · ${
                            booking.customer?.full_name ?? ''
                          } · ${booking.status ? statusLabel(booking.status, t) : ''}`}
                        >
                          <span className="block truncate font-medium">
                            {booking.property?.name}
                          </span>
                          <span className="block truncate">{booking.customer?.full_name}</span>
                          {booking.conflict_override ? (
                            <span className="block truncate text-amber-800">
                              {t('booking.conflict.badge')}
                            </span>
                          ) : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </Panel>

      {visible.length === 0 ? (
        <p className="mt-4 text-sm text-slate-600">{t('calendar.empty')}</p>
      ) : (
        <p className="mt-4 text-sm text-slate-600">{t('calendar.legend')}</p>
      )}
    </>
  );
}
