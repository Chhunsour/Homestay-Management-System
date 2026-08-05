import { Redirect } from 'expo-router';
import { can } from '@homestay/shared';
import { CustomerForm } from '@/components/CustomerForm';
import { Screen, Title } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function NewCustomerScreen() {
  const { t, business } = useSession();
  if (!business) return null;
  // RLS checks this again; this only avoids showing a dead form.
  if (!can(business.role, 'customers.manage')) return <Redirect href="/(tabs)/customers" />;

  return (
    <Screen>
      <Title title={t('customer.new')} subtitle={t('customer.subtitle')} />
      <CustomerForm />
    </Screen>
  );
}
