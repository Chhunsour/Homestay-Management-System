import { useState } from 'react';
import { Link } from 'expo-router';
import { makeRedirectUri } from 'expo-auth-session';
import { StyleSheet, View } from 'react-native';
import { authErrorKey, fieldErrors, signUpSchema, type TranslationKey } from '@homestay/shared';
import { Banner, Button, Field, Screen, Title, colors } from '@/components/ui';
import { OAuthRow } from '@/components/OAuthRow';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

export default function SignUpScreen() {
  const { t, locale } = useSession();

  const [values, setValues] = useState({
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const fieldError = (name: string): string | undefined => {
    const key = errors[name];
    return key ? t(key as TranslationKey) : undefined;
  };

  async function submit(): Promise<void> {
    setErrors({});
    setErrorKey(null);
    setBusy(true);

    try {
      const parsed = signUpSchema.safeParse(values);
      if (!parsed.success) return setErrors(fieldErrors(parsed.error));

      const { data, error } = await supabase.auth.signUp({
        email: parsed.data.email,
        password: parsed.data.password,
        options: {
          // Read by the handle_new_user() trigger to seed the profile.
          data: { full_name: parsed.data.fullName, language: locale },
          emailRedirectTo: makeRedirectUri({ path: 'auth/callback' }),
        },
      });
      if (error) return setErrorKey(authErrorKey(error));

      // No session means email confirmation is enabled.
      if (!data.session) setSent(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title title={t('auth.signUp.title')} subtitle={t('auth.signUp.subtitle')} />

      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}
      {sent ? <Banner tone="success">{t('auth.signUp.checkEmail')}</Banner> : null}

      <Field
        label={t('auth.field.fullName')}
        value={values.fullName}
        onChangeText={set('fullName')}
        error={fieldError('fullName')}
        autoComplete="name"
      />
      <Field
        label={t('auth.field.email')}
        value={values.email}
        onChangeText={set('email')}
        error={fieldError('email')}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
      />
      <Field
        label={t('auth.field.password')}
        value={values.password}
        onChangeText={set('password')}
        error={fieldError('password')}
        hint={t('validation.password.min')}
        autoCapitalize="none"
        autoComplete="new-password"
        secureTextEntry
      />
      <Field
        label={t('auth.field.confirmPassword')}
        value={values.confirmPassword}
        onChangeText={set('confirmPassword')}
        error={fieldError('confirmPassword')}
        autoCapitalize="none"
        autoComplete="new-password"
        secureTextEntry
      />

      <Button label={t('auth.signUp.submit')} loading={busy} onPress={() => void submit()} />

      <OAuthRow />

      <View style={styles.links}>
        <Link href="/sign-in" style={styles.link}>
          {t('auth.signUp.signIn')}
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  links: { alignItems: 'center', paddingTop: 4 },
  link: { fontSize: 14, fontWeight: '500', color: colors.brandDark },
});
