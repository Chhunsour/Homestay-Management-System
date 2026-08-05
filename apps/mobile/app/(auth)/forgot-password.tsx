import { useState } from 'react';
import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { fieldErrors, forgotPasswordSchema, type TranslationKey } from '@homestay/shared';
import { Banner, Button, Field, Screen, Title, colors } from '@/components/ui';
import { env } from '@/lib/env';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

export default function ForgotPasswordScreen() {
  const { t } = useSession();
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [messageKey, setMessageKey] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setErrors({});
    setMessageKey(null);
    setBusy(true);

    try {
      const parsed = forgotPasswordSchema.safeParse({ email });
      if (!parsed.success) return setErrors(fieldErrors(parsed.error));

      // ponytail: the reset form itself lives in the web app; the emailed link
      // opens there. Add a native reset screen when the app ships standalone.
      const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
        redirectTo: `${env.siteUrl}/auth/callback?next=/reset-password`,
      });

      // Rate limits are worth showing; everything else stays vague so this
      // screen cannot be used to discover which addresses have accounts.
      setMessageKey(error && error.status === 429 ? 'auth.error.rateLimit' : 'auth.forgot.sent');
    } finally {
      setBusy(false);
    }
  }

  const isError = messageKey === 'auth.error.rateLimit';

  return (
    <Screen>
      <Title title={t('auth.forgot.title')} subtitle={t('auth.forgot.subtitle')} />

      {messageKey ? <Banner tone={isError ? 'error' : 'success'}>{t(messageKey)}</Banner> : null}

      <Field
        label={t('auth.field.email')}
        value={email}
        onChangeText={setEmail}
        error={errors.email ? t(errors.email as TranslationKey) : undefined}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
      />

      <Button label={t('auth.forgot.submit')} loading={busy} onPress={() => void submit()} />

      <View style={styles.links}>
        <Link href="/sign-in" style={styles.link}>
          {t('common.back')}
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  links: { alignItems: 'center', paddingTop: 4 },
  link: { fontSize: 14, fontWeight: '500', color: colors.brandDark },
});
