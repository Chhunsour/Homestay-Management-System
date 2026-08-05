import { useState } from 'react';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { authErrorKey, type TranslationKey } from '@homestay/shared';
import { Banner, Button } from '@/components/ui';
import { env } from '@/lib/env';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

const LABEL_KEYS = { google: 'auth.google', apple: 'auth.apple' } as const;

/**
 * Google/Apple through the system browser. Deliberately no
 * expo-apple-authentication: the web flow already works on both platforms and
 * needs no extra native module for Phase 1.
 */
export function OAuthRow() {
  const { t, refresh } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const providers = env.authProviders.filter(
    (provider): provider is 'google' | 'apple' => provider === 'google' || provider === 'apple',
  );
  if (providers.length === 0) return null;

  async function start(provider: 'google' | 'apple'): Promise<void> {
    setBusy(provider);
    setErrorKey(null);

    try {
      const redirectTo = makeRedirectUri({ path: 'auth/callback' });
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (error || !data.url) {
        setErrorKey(error ? authErrorKey(error) : 'error.generic');
        return;
      }

      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (result.type !== 'success') return;

      const code = Linking.parse(result.url).queryParams?.code;
      if (typeof code !== 'string') {
        setErrorKey('error.generic');
        return;
      }

      const exchange = await supabase.auth.exchangeCodeForSession(code);
      if (exchange.error) setErrorKey(authErrorKey(exchange.error));
      else await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}
      {providers.map((provider) => (
        <Button
          key={provider}
          variant="secondary"
          label={t(LABEL_KEYS[provider])}
          loading={busy === provider}
          disabled={busy !== null}
          onPress={() => void start(provider)}
        />
      ))}
    </>
  );
}
