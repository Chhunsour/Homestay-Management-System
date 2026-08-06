import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createTranslator, formatDateTime, formatMoney, statusLabel } from '@homestay/shared';
import type { BookingWithDetails, TranslationKey } from '@homestay/shared';
import { StatusChip } from '@/components/bookings/StatusChip';
import { DataRow, PageHeader, Panel } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { getDashboardBookings } from '@/lib/bookings';
import { paymentDashboard } from '@/lib/payments';
import { getSessionUser } from '@/lib/supabase/server';

export default async function DashboardPage() {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const locale = await getLocale();
  const t = createTranslator(locale);
  const [user, board, money] = await Promise.all([
    getSessionUser(),
    getDashboardBookings(context),
    paymentDashboard(context),
  ]);
  const { timezone } = context;

  const fullName = user?.user_metadata?.full_name;
  const name = typeof fullName === 'string' && fullName ? fullName : (user?.email ?? '');

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
      <Panel className="h-full overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <h2
            className={`font-display text-lg font-semibold ${tone === 'alert' ? 'text-rose-900' : 'text-slate-900'}`}
          >
            {t(titleKey)}{' '}
            <span className="ml-1 font-sans text-xs font-semibold text-slate-500">
              {bookings.length}
            </span>
          </h2>
          <Link
            href="/bookings"
            className="rounded-md px-2 py-1 text-sm font-semibold text-brand-800 transition hover:bg-brand-50"
          >
            {t('dashboard.viewAll')}
          </Link>
        </div>
        {bookings.length === 0 ? (
          <p className="border-t border-slate-100 px-5 py-8 text-sm text-slate-600">
            {t('dashboard.none')}
          </p>
        ) : (
          <ul className="border-t border-slate-100">
            {bookings.slice(0, 5).map((booking) => (
              <li
                key={booking.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5 transition hover:bg-brand-50/60 last:border-b-0"
              >
                <div className="min-w-0">
                  <Link
                    href={`/bookings/${booking.id}`}
                    className="text-sm font-semibold text-slate-900 hover:text-brand-700"
                  >
                    {booking.property?.name ?? booking.booking_number}
                  </Link>
                  <p className="mt-0.5 truncate text-sm text-slate-500">
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

  function Money({
    labelKey,
    value,
    size = 'small',
  }: {
    labelKey: TranslationKey;
    value: string;
    size?: 'small' | 'medium' | 'large';
  }) {
    return (
      <Link
        href="/payments"
        className={`panel group block min-h-32 overflow-hidden px-5 py-5 transition duration-200 hover:-translate-y-0.5 ${
          size === 'large'
            ? 'col-span-2 bg-brand-900 text-white xl:col-span-5'
            : size === 'medium'
              ? 'col-span-2 xl:col-span-3'
              : 'xl:col-span-2'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <p
            className={`text-sm font-medium ${size === 'large' ? 'text-brand-100' : 'text-slate-500'}`}
          >
            {t(labelKey)}
          </p>
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${size === 'large' ? 'bg-accent-500' : 'bg-brand-200'}`}
          />
        </div>
        <p
          className={`mt-6 font-display font-semibold tabular-nums tracking-tight ${
            size === 'large' ? 'text-4xl text-white' : 'text-3xl text-slate-900'
          }`}
        >
          {value}
        </p>
      </Link>
    );
  }

  return (
    <>
      <PageHeader title={t('dashboard.title')} description={t('dashboard.welcome', { name })} />

      <div className="space-y-6">
        {/* The four money questions an owner opens the app to answer. */}
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-12">
          <Money
            labelKey="dashboard.balanceDue"
            value={formatMoney(locale, money.balanceDue, context.default_currency)}
            size="large"
          />
          <Money
            labelKey="dashboard.paidToday"
            value={formatMoney(locale, money.paidToday, context.default_currency)}
            size="medium"
          />
          <Money labelKey="dashboard.unpaid" value={String(money.unpaid)} />
          <Money labelKey="dashboard.deposits" value={String(money.awaitingDeposit)} />
        </div>

        {board.expired.length > 0 ? (
          <BookingList
            titleKey="dashboard.expired"
            bookings={board.expired}
            field="check_in_at"
            tone="alert"
          />
        ) : null}

        <div className="grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <BookingList titleKey="dashboard.today" bookings={board.today} field="check_in_at" />
          </div>
          <div className="lg:col-span-5">
            <BookingList
              titleKey="dashboard.checkIns"
              bookings={board.checkIns}
              field="check_in_at"
            />
          </div>
          <div className="lg:col-span-5">
            <BookingList
              titleKey="dashboard.checkOuts"
              bookings={board.checkOuts}
              field="check_out_at"
            />
          </div>
          <div className="lg:col-span-7">
            <BookingList
              titleKey="dashboard.pending"
              bookings={board.pending}
              field="check_in_at"
            />
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-12">
          <Panel className="overflow-hidden lg:col-span-7">
            <div className="px-5 py-4">
              <h2 className="font-display text-lg font-semibold text-slate-900">
                {t('dashboard.available')}
              </h2>
            </div>
            {board.availableProperties.length === 0 ? (
              <p className="border-t border-slate-100 px-5 py-8 text-sm text-slate-600">
                {t('dashboard.none')}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2 border-t border-slate-100 px-5 py-5">
                {board.availableProperties.map((property) => (
                  <li key={property.id}>
                    <Link
                      href={`/properties/${property.id}`}
                      className="inline-flex rounded-lg bg-brand-100 px-3 py-1.5 text-xs font-semibold text-brand-900 transition hover:bg-brand-200"
                    >
                      {property.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel className="overflow-hidden lg:col-span-5">
            <dl>
              <DataRow label={t('dashboard.business')} value={context.business_name} />
              <DataRow label={t('dashboard.role')} value={t(`role.${context.role}`)} />
              <DataRow label={t('dashboard.members')} value={context.member_count} />
            </dl>
          </Panel>
        </div>
      </div>
    </>
  );
}
