import { Redirect, Stack } from 'expo-router';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';

/** Signed-in users have no business on the auth screens. */
export default function AuthLayout() {
  const { ready, user, business } = useSession();

  if (!ready) return <Loading />;
  if (user) return <Redirect href={business ? '/(tabs)' : '/onboarding'} />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
