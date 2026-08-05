import { useCallback, useState } from 'react';
import { Redirect, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { can } from '@homestay/shared';
import type {
  BookingStatus,
  BookingWithDetails,
  Customer,
  PropertyWithDetails,
} from '@homestay/shared';
import { Banner, Button, Screen, Title } from '@/components/ui';
import { BookingForm } from '@/components/BookingForm';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import {
  getBooking,
  listBookableProperties,
  listBookingStatuses,
  listCustomerOptions,
} from '@/lib/bookings';

export default function NewBookingScreen() {
  const { t, business } = useSession();
  // `from` duplicates an existing booking: it seeds the form and saves as new.
  const { from } = useLocalSearchParams<{ from?: string }>();

  const [properties, setProperties] = useState<PropertyWithDetails[]>([]);
  const [customers, setCustomers] = useState<Pick<Customer, 'id' | 'full_name' | 'phone'>[]>([]);
  const [statuses, setStatuses] = useState<BookingStatus[]>([]);
  const [draft, setDraft] = useState<BookingWithDetails | undefined>();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  const businessId = business?.business_id;

  const load = useCallback(async (): Promise<void> => {
    if (!businessId) return;
    try {
      const [propertyList, customerList, statusList, source] = await Promise.all([
        listBookableProperties(businessId),
        listCustomerOptions(businessId),
        listBookingStatuses(businessId),
        from ? getBooking(businessId, from) : Promise.resolve(null),
      ]);
      setProperties(propertyList);
      setCustomers(customerList);
      setStatuses(statusList);
      setDraft(source ? { ...source, id: '', booking_number: '' } : undefined);
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [businessId, from]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!business) return null;
  // RLS and the RPC check this again; this only avoids showing a dead form.
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

  return (
    <Screen>
      <Title title={t('booking.quick')} subtitle={t('booking.quick.subtitle')} />
      {properties.length === 0 ? (
        <Banner tone="info">{t('booking.error.pricingMissing')}</Banner>
      ) : (
        <BookingForm
          booking={draft}
          properties={properties}
          customers={customers}
          statuses={statuses}
          canOverridePrice={can(business.role, 'bookings.price.override')}
          canOverrideConflict={can(business.role, 'bookings.conflict.override')}
        />
      )}
    </Screen>
  );
}
