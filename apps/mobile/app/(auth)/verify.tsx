import { useState } from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import {
  authErrorKey,
  fieldErrors,
  phoneSignInSchema,
  verifyOtpSchema,
  type TranslationKey,
} from '@homestay/shared';
import { Banner, Button, Field, Screen, Title } from '@/components/ui';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

export default function VerifyScreen() {
  const { t } = useSession();
  const params = useLocalSearchParams<{ phone?: string }>();
  const phone = typeof params.phone === 'string' ? params.phone : '';

  const [token, setToken] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [resentKey, setResentKey] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);

  // Nothing to verify without a phone number to verify it against.
  if (!phone) return <Redirect href="/sign-in" />;

  async function submit(): Promise<void> {
    setErrors({});
    setErrorKey(null);
    setResentKey(null);
    setBusy(true);

    try {
      const parsed = verifyOtpSchema.safeParse({ token });
      if (!parsed.success) return setErrors(fieldErrors(parsed.error));

      const { error } = await supabase.auth.verifyOtp({
        phone,
        token: parsed.data.token,
        type: 'sms',
      });
      // On success the session listener routes away from this screen.
      if (error) setErrorKey(authErrorKey(error));
    } finally {
      setBusy(false);
    }
  }

  async function resend(): Promise<void> {
    setErrorKey(null);
    setResentKey(null);
    setBusy(true);

    try {
      const parsed = phoneSignInSchema.safeParse({ phone });
      if (!parsed.success) return setErrorKey('validation.phone');

      const { error } = await supabase.auth.signInWithOtp({ phone: parsed.data.phone });
      if (error) setErrorKey(authErrorKey(error));
      else setResentKey('auth.verify.resent');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title
        title={t('auth.verify.title')}
        subtitle={t('auth.verify.subtitlePhone', { target: phone })}
      />

      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}
      {resentKey ? <Banner tone="success">{t(resentKey)}</Banner> : null}

      <Field
        label={t('auth.field.code')}
        value={token}
        onChangeText={setToken}
        error={errors.token ? t(errors.token as TranslationKey) : undefined}
        keyboardType="number-pad"
        maxLength={6}
        textContentType="oneTimeCode"
      />

      <Button label={t('auth.verify.submit')} loading={busy} onPress={() => void submit()} />
      <Button
        label={t('auth.verify.resend')}
        variant="ghost"
        disabled={busy}
        onPress={() => void resend()}
      />
    </Screen>
  );
}
