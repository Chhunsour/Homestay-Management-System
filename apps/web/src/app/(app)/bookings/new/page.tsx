import { redirect } from 'next/navigation';
import { can, createTranslator } from '@homestay/shared';
import { BookingForm } from '@/components/bookings/BookingForm';
import { PageHeader } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import {
  getBooking,
  listBookableProperties,
  listBookingStatuses,
  listCustomerOptions,
} from '@/lib/bookings';

export default async function NewBookingPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');
  // The action and the RPC check this again; this only avoids showing a form
  // that could never be submitted.
  if (!can(context.role, 'bookings.manage')) redirect('/bookings');

  const locale = await getLocale();
  const t = createTranslator(locale);
  const { from } = await searchParams;

  const [properties, customers, statuses, source] = await Promise.all([
    listBookableProperties(context),
    listCustomerOptions(context),
    listBookingStatuses(context),
    // "Duplicate as new": the old booking seeds the form but nothing is saved
    // until the user submits, so the copy starts as a draft.
    from ? getBooking(context, from) : Promise.resolve(null),
  ]);

  const draft = source ? { ...source, id: '', booking_number: '' } : undefined;

  return (
    <>
      <PageHeader title={t('booking.new')} />
      <BookingForm
        booking={draft}
        properties={properties}
        customers={customers}
        statuses={statuses}
        timezone={context.timezone}
        locale={locale}
        canOverridePrice={can(context.role, 'bookings.price.override')}
        canOverrideConflict={can(context.role, 'bookings.conflict.override')}
      />
    </>
  );
}
