import { useEffect, useState } from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { can } from '@homestay/shared';
import type { PropertyWithDetails } from '@homestay/shared';
import { PropertyForm } from '@/components/PropertyForm';
import { Banner, Empty, Screen, Title } from '@/components/ui';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { getProperty } from '@/lib/properties';

export default function EditPropertyScreen() {
  const { t, business } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [property, setProperty] = useState<PropertyWithDetails | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const businessId = business?.business_id;

  useEffect(() => {
    let active = true;
    if (!businessId || !id) return;

    void (async () => {
      try {
        const row = await getProperty(businessId, id);
        if (!active) return;
        setProperty(row);
        setState('ready');
      } catch {
        if (active) setState('failed');
      }
    })();

    return () => {
      active = false;
    };
  }, [businessId, id]);

  if (!business) return null;
  if (!can(business.role, 'properties.manage')) return <Redirect href="/(tabs)/properties" />;

  return (
    <Screen>
      <Title title={t('property.edit')} subtitle={property?.name} />
      {state === 'loading' ? <Loading /> : null}
      {state === 'failed' ? <Banner tone="error">{t('error.network')}</Banner> : null}
      {state === 'ready' && !property ? (
        <Empty title={t('property.notFound')} body={t('property.empty.body')} />
      ) : null}
      {property ? <PropertyForm property={property} /> : null}
    </Screen>
  );
}
