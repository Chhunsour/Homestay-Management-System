import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createTranslator, formatDateTime, statusLabel } from '@homestay/shared';
import type { BookingWithDetails, TranslationKey } from '@homestay/shared';
import { StatusChip } from '@/components/bookings/StatusChip';
import { DataRow, PageHeader, Panel } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { getDashboardBookings } from '@/lib/bookings';
import { getSessionUser } from '@/lib/supabase/server';

export default async function DashboardPage() {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const locale = await getLocale();
  const t = createTranslator(locale);
  const [user, board] = await Promise.all([getSessionUser(), getDashboardBookings(context)]);
  const { timezone } = context;

  const fullName = user?.user_metadata?.full_name;
  const name = typeof fullName === 'string' && fullName ? fullName : (user?.email ?? '');

  // Money stays out of here until Phase 5: half a revenue figure is worse than none.
  function BookingList({
    titleKey,
    bookings,
    field,
    tone,
  }: {
    titleKey: TranslationKey;
    bookings: BookingWithDetails[];
    field: 'check_in_at' | 'check_out_at';
    tone?: 'alert';
  }) {
    return (
      <Panel>
        <div className="flex items-center justify-between gap-2 px-5 py-3.5">
          <h2
            className={`text-sm font-semibold ${tone === 'alert' ? 'text-rose-900' : 'text-slate-900'}`}
          >
            {t(titleKey)}
          </h2>
          <Link href="/bookings" className="text-sm text-brand-800 hover:underline">
            {t('dashboard.viewAll')}
          </Link>
        </div>
        {bookings.length === 0 ? (
          <p className="border-t border-slate-100 px-5 py-6 text-sm text-slate-600">
            {t('dashboard.none')}
          </p>
        ) : (
          <ul className="border-t border-slate-100">
            {bookings.slice(0, 5).map((booking) => (
              <li
                key={booking.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <Link
                    href={`/bookings/${booking.id}`}
                    className="text-sm font-medium text-brand-800 hover:underline"
                  >
                    {booking.property?.name ?? booking.booking_number}
                  </Link>
                  <p className="truncate text-sm text-slate-600">
                    {booking.customer?.full_name ?? ''} ·{' '}
                    {formatDateTime(locale, booking[field], timezone)}
                  </p>
                </div>
                {booking.status ? (
                  <StatusChip label={statusLabel(booking.status, t)} color={booking.status.color} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    );
  }

  return (
    <>
      <PageHeader title={t('dashboard.title')} description={t('dashboard.welcome', { name })} />

      <div className="space-y-6">
        {board.expired.length > 0 ? (
          <BookingList
            titleKey="dashboard.expired"
            bookings={board.expired}
            field="check_in_at"
            tone="alert"
          />
        ) : null}

        <div className="grid gap-6 lg:grid-cols-2">
          <BookingList titleKey="dashboard.today" bookings={board.today} field="check_in_at" />
          <BookingList
            titleKey="dashboard.checkIns"
            bookings={board.checkIns}
            field="check_in_at"
          />
          <BookingList
            titleKey="dashboard.checkOuts"
            bookings={board.checkOuts}
            field="check_out_at"
          />
          <BookingList titleKey="dashboard.pending" bookings={board.pending} field="check_in_at" />
        </div>

        <Panel>
          <div className="px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('dashboard.available')}</h2>
          </div>
          {board.availableProperties.length === 0 ? (
            <p className="border-t border-slate-100 px-5 py-6 text-sm text-slate-600">
              {t('dashboard.none')}
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2 border-t border-slate-100 px-5 py-4">
              {board.availableProperties.map((property) => (
                <li key={property.id}>
                  <Link
                    href={`/properties/${property.id}`}
                    className="inline-flex rounded-sm bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200 ring-inset hover:bg-emerald-100"
                  >
                    {property.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <dl>
            <DataRow label={t('dashboard.business')} value={context.business_name} />
            <DataRow label={t('dashboard.role')} value={t(`role.${context.role}`)} />
            <DataRow label={t('dashboard.members')} value={context.member_count} />
          </dl>
        </Panel>
      </div>
    </>
  );
}
