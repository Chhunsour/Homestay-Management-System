import { useCallback, useState } from 'react';
import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { can } from '@homestay/shared';
import type { BookingStatus, BookingWithDetails, Customer } from '@homestay/shared';
import { Banner, Button, Empty, Screen, Title } from '@/components/ui';
import { BookingForm, type PropertyOption } from '@/components/BookingForm';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import {
  getBooking,
  listBookableProperties,
  listBookingStatuses,
  listCustomerOptions,
} from '@/lib/bookings';

export default function EditBookingScreen() {
  const { t, business } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [booking, setBooking] = useState<BookingWithDetails | null>(null);
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [customers, setCustomers] = useState<Pick<Customer, 'id' | 'full_name' | 'phone'>[]>([]);
  const [statuses, setStatuses] = useState<BookingStatus[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  const businessId = business?.business_id;

  const load = useCallback(async (): Promise<void> => {
    if (!businessId || !id) return;
    try {
      const [row, propertyList, customerList, statusList] = await Promise.all([
        getBooking(businessId, id),
        listBookableProperties(businessId),
        listCustomerOptions(businessId),
        listBookingStatuses(businessId),
      ]);
      setBooking(row);
      // An archived property must stay selectable, or saving would silently
      // move the booking to whichever property happens to be first.
      setProperties(
        row && !propertyList.some((property) => property.id === row.property_id)
          ? [...propertyList, { id: row.property_id, name: row.property?.name ?? '' }]
          : propertyList,
      );
      setCustomers(customerList);
      setStatuses(statusList);
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [businessId, id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!business) return null;
  if (!can(business.role, 'bookings.manage')) return <Redirect href="/(tabs)/bookings" />;

  if (state === 'loading') {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }

  if (state === 'failed') {
    return (
      <Screen>
        <Banner tone="error">{t('error.network')}</Banner>
        <Button label={t('common.retry')} onPress={() => void load()} />
      </Screen>
    );
  }

  if (!booking) {
    return (
      <Screen>
        <Empty title={t('booking.error.notFound')} body={t('booking.empty.body')} />
        <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title title={t('booking.edit')} subtitle={booking.booking_number} />
      <BookingForm
        booking={booking}
        properties={properties}
        customers={customers}
        statuses={statuses}
        canOverridePrice={can(business.role, 'bookings.price.override')}
        canOverrideConflict={can(business.role, 'bookings.conflict.override')}
      />
    </Screen>
  );
}
