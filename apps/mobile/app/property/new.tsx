import { Redirect } from 'expo-router';
import { can } from '@homestay/shared';
import { PropertyForm } from '@/components/PropertyForm';
import { Screen, Title } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function NewPropertyScreen() {
  const { t, business } = useSession();
  if (!business) return null;
  // The RPC and RLS check this again; this only avoids showing a dead form.
  if (!can(business.role, 'properties.manage')) return <Redirect href="/(tabs)/properties" />;

  return (
    <Screen>
      <Title title={t('property.new')} />
      <PropertyForm />
    </Screen>
  );
}
