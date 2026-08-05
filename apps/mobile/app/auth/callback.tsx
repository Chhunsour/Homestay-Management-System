import { useEffect, useState } from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

/**
 * Deep-link target for email confirmation and OAuth. Trades the one-time code
 * for a session, then hands back to the entry gate.
 */
export default function AuthCallbackScreen() {
  const { refresh } = useSession();
  const params = useLocalSearchParams<{ code?: string }>();
  const code = typeof params.code === 'string' ? params.code : null;
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;

    void (async () => {
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) await refresh();
      }
      if (active) setDone(true);
    })();

    return () => {
      active = false;
    };
  }, [code, refresh]);

  return done ? <Redirect href="/" /> : <Loading />;
}
