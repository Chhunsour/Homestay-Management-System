import { Redirect, Tabs } from 'expo-router';
import { Loading } from '@/components/Loading';
import { colors } from '@/components/ui';
import { useSession } from '@/lib/session';

/** Protected area: no session or no business means you do not get here. */
export default function TabsLayout() {
  const { ready, user, business, t } = useSession();

  if (!ready) return <Loading />;
  if (!user) return <Redirect href="/sign-in" />;
  if (!business) return <Redirect href="/onboarding" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: { fontSize: 12 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('nav.home') }} />
      <Tabs.Screen name="properties" options={{ title: t('nav.properties') }} />
      <Tabs.Screen name="calendar" options={{ title: t('nav.calendar') }} />
      <Tabs.Screen name="bookings" options={{ title: t('nav.bookings') }} />
      <Tabs.Screen name="customers" options={{ title: t('nav.customers') }} />
      <Tabs.Screen name="settings" options={{ title: t('nav.settings') }} />
    </Tabs>
  );
}
