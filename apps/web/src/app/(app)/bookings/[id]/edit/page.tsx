import { notFound, redirect } from 'next/navigation';
import { can, createTranslator } from '@homestay/shared';
import { BookingForm, type PropertyOption } from '@/components/bookings/BookingForm';
import { PageHeader } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import {
  getBooking,
  listBookableProperties,
  listBookingStatuses,
  listCustomerOptions,
} from '@/lib/bookings';

export default async function EditBookingPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');
  if (!can(context.role, 'bookings.manage')) redirect('/bookings');

  const { id } = await params;
  const locale = await getLocale();
  const t = createTranslator(locale);

  const [booking, properties, customers, statuses] = await Promise.all([
    getBooking(context, id),
    listBookableProperties(context),
    listCustomerOptions(context),
    listBookingStatuses(context),
  ]);
  if (!booking) notFound();

  // The property may since have been archived; keep it selectable so editing
  // the dates of an old booking does not silently move it somewhere else.
  const options: PropertyOption[] = properties.some(
    (property) => property.id === booking.property_id,
  )
    ? properties
    : [...properties, { id: booking.property_id, name: booking.property?.name ?? '' }];

  return (
    <>
      <PageHeader
        title={t('booking.edit')}
        description={t('booking.detail.title', { number: booking.booking_number })}
      />
      <BookingForm
        booking={booking}
        properties={options}
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
