import { Redirect } from 'expo-router';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';

/** Entry gate: restore the session first, then send the user where they belong. */
export default function IndexScreen() {
  const { ready, user, business } = useSession();

  if (!ready) return <Loading />;
  if (!user) return <Redirect href="/sign-in" />;
  if (!business) return <Redirect href="/onboarding" />;
  return <Redirect href="/(tabs)" />;
}
