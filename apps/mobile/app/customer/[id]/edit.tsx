import { useEffect, useState } from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { can } from '@homestay/shared';
import type { Customer } from '@homestay/shared';
import { CustomerForm } from '@/components/CustomerForm';
import { Banner, Empty, Screen, Title } from '@/components/ui';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { getCustomer } from '@/lib/customers';

export default function EditCustomerScreen() {
  const { t, business } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const businessId = business?.business_id;

  useEffect(() => {
    let active = true;
    if (!businessId || !id) return;

    void (async () => {
      try {
        const row = await getCustomer(businessId, id);
        if (!active) return;
        setCustomer(row);
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
  if (!can(business.role, 'customers.manage')) return <Redirect href="/(tabs)/customers" />;
  // Archived customers are read-only until someone restores them.
  if (customer?.archived_at) return <Redirect href={`/customer/${customer.id}`} />;

  return (
    <Screen>
      <Title title={t('customer.edit')} subtitle={customer?.full_name} />
      {state === 'loading' ? <Loading /> : null}
      {state === 'failed' ? <Banner tone="error">{t('error.network')}</Banner> : null}
      {state === 'ready' && !customer ? (
        <Empty title={t('customer.notFound')} body={t('customer.empty.body')} />
      ) : null}
      {customer ? <CustomerForm customer={customer} /> : null}
    </Screen>
  );
}
