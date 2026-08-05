import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  can,
  createTranslator,
  finalPrice,
  formatDateTime,
  formatMoney,
  isPendingExpired,
  statusLabel,
} from '@homestay/shared';
import { BookingActions } from '@/components/bookings/BookingActions';
import { StatusChip } from '@/components/bookings/StatusChip';
import { DataRow, PageHeader, Panel, buttonStyles } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { getBooking, listBookingStatuses } from '@/lib/bookings';

export default async function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const { id } = await params;
  const locale = await getLocale();
  const t = createTranslator(locale);

  const [booking, statuses] = await Promise.all([
    getBooking(context, id),
    listBookingStatuses(context),
  ]);
  if (!booking) notFound();

  const expired = isPendingExpired(booking);
  const canManage = can(context.role, 'bookings.manage');

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title={t('booking.detail.title', { number: booking.booking_number })}
          description={booking.property?.name ?? undefined}
        />
        <div className="flex flex-wrap items-center gap-2">
          {canManage ? (
            <>
              <Link href={`/bookings/new?from=${booking.id}`} className={buttonStyles('secondary')}>
                {t('booking.duplicate')}
              </Link>
              <Link href={`/bookings/${booking.id}/edit`} className={buttonStyles()}>
                {t('common.edit')}
              </Link>
            </>
          ) : null}
        </div>
      </div>

      {expired ? (
        <p className="mb-5 rounded-sm border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {t('booking.pending.expired')}
        </p>
      ) : null}
      {booking.conflict_override ? (
        <p className="mb-5 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t('booking.conflict.badge')}
          {booking.conflict_override_at
            ? ` — ${t('booking.conflict.approved', {
                date: formatDateTime(locale, booking.conflict_override_at, context.timezone),
              })}`
            : ''}
          {booking.conflict_override_reason ? ` · ${booking.conflict_override_reason}` : ''}
        </p>
      ) : null}

      <div className="space-y-6">
        <Panel>
          <div className="flex items-center justify-between gap-2 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('booking.title')}</h2>
            {booking.status ? (
              <StatusChip label={statusLabel(booking.status, t)} color={booking.status.color} />
            ) : null}
          </div>
          <dl className="border-t border-slate-100">
            <DataRow label={t('booking.number')} value={booking.booking_number} />
            <DataRow
              label={t('booking.property')}
              value={
                booking.property ? (
                  <Link
                    href={`/properties/${booking.property.id}`}
                    className="text-brand-800 hover:underline"
                  >
                    {booking.property.name}
                  </Link>
                ) : (
                  t('common.notSet')
                )
              }
            />
            <DataRow
              label={t('booking.customer')}
              value={
                booking.customer ? (
                  <Link
                    href={`/guests/${booking.customer.id}`}
                    className="text-brand-800 hover:underline"
                  >
                    {booking.customer.full_name} — {booking.customer.phone}
                  </Link>
                ) : (
                  t('common.notSet')
                )
              }
            />
            <DataRow
              label={t('booking.checkIn')}
              value={formatDateTime(locale, booking.check_in_at, context.timezone)}
            />
            <DataRow
              label={t('booking.checkOut')}
              value={formatDateTime(locale, booking.check_out_at, context.timezone)}
            />
            <DataRow
              label={t('booking.source')}
              value={t(`booking.source.${booking.source}` as 'booking.source.other')}
            />
            {booking.pending_expires_at && !expired ? (
              <DataRow
                label={t('booking.status.pending')}
                value={t('booking.pending.holds', {
                  time: formatDateTime(locale, booking.pending_expires_at, context.timezone),
                })}
              />
            ) : null}
          </dl>
        </Panel>

        <Panel>
          <div className="px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('booking.price')}</h2>
          </div>
          <dl className="border-t border-slate-100">
            {/* Both numbers stay on the record: the rates that applied on the day,
                and what was actually charged. */}
            <DataRow
              label={t('booking.price.calculated')}
              value={formatMoney(locale, booking.calculated_price, booking.currency)}
            />
            <DataRow
              label={t('booking.price.final')}
              value={formatMoney(locale, finalPrice(booking), booking.currency)}
            />
            {booking.price_overridden ? (
              <DataRow
                label={t('booking.price.override.reason')}
                value={booking.price_override_reason || t('common.notSet')}
              />
            ) : null}
          </dl>
        </Panel>

        <Panel>
          <div className="px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('booking.note')}</h2>
          </div>
          <dl className="border-t border-slate-100">
            <DataRow label={t('booking.note')} value={booking.note || t('common.notSet')} />
            <DataRow
              label={t('booking.internalNote')}
              value={booking.internal_note || t('common.notSet')}
            />
          </dl>
        </Panel>

        {canManage ? (
          <BookingActions
            booking={booking}
            statuses={statuses}
            canCancel={can(context.role, 'bookings.cancel')}
            canRestore={can(context.role, 'bookings.restore')}
            canResolvePending={can(context.role, 'bookings.pending.resolve')}
            expired={expired}
          />
        ) : null}

        <p className="text-xs text-slate-500">
          {t('booking.audit', {
            created: formatDateTime(locale, booking.created_at, context.timezone),
            updated: formatDateTime(locale, booking.updated_at, context.timezone),
          })}
        </p>
      </div>
    </>
  );
}
