import { redirect } from 'next/navigation';
import { can, createTranslator } from '@homestay/shared';
import { StatusManager } from '@/components/bookings/StatusManager';
import { PageHeader, Panel } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { listBookingStatuses } from '@/lib/bookings';

export default async function BookingStatusesPage() {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');
  if (!can(context.role, 'bookings.statuses.manage')) redirect('/bookings');

  const t = createTranslator(await getLocale());
  // Disabled statuses have to be listed, or they could never be switched back on.
  const statuses = await listBookingStatuses(context, true);

  return (
    <>
      <PageHeader title={t('status.title')} description={t('status.subtitle')} />
      <Panel>
        <StatusManager statuses={statuses} />
      </Panel>
      <p className="mt-3 text-sm text-slate-600">{t('calendar.legend')}</p>
    </>
  );
}
