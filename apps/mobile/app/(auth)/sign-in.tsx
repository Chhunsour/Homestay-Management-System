import { useState } from 'react';
import { Link, router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  authErrorKey,
  fieldErrors,
  phoneSignInSchema,
  signInWithPasswordSchema,
  type TranslationKey,
} from '@homestay/shared';
import { Banner, Button, Field, Screen, Title, colors } from '@/components/ui';
import { LanguageToggle } from '@/components/LanguageToggle';
import { OAuthRow } from '@/components/OAuthRow';
import { env } from '@/lib/env';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

export default function SignInScreen() {
  const { t } = useSession();
  const phoneEnabled = env.authProviders.includes('phone');

  const [method, setMethod] = useState<'email' | 'phone'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);

  const fieldError = (name: string): string | undefined => {
    const key = errors[name];
    return key ? t(key as TranslationKey) : undefined;
  };

  async function submit(): Promise<void> {
    setErrors({});
    setErrorKey(null);
    setBusy(true);

    try {
      if (method === 'email') {
        const parsed = signInWithPasswordSchema.safeParse({ email, password });
        if (!parsed.success) return setErrors(fieldErrors(parsed.error));

        const { error } = await supabase.auth.signInWithPassword(parsed.data);
        if (error) return setErrorKey(authErrorKey(error));
        // The session listener re-routes; nothing to navigate here.
        return;
      }

      const parsed = phoneSignInSchema.safeParse({ phone });
      if (!parsed.success) return setErrors(fieldErrors(parsed.error));

      const { error } = await supabase.auth.signInWithOtp({ phone: parsed.data.phone });
      if (error) return setErrorKey(authErrorKey(error));

      router.push({ pathname: '/verify', params: { phone: parsed.data.phone } });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.brand}>{t('app.name')}</Text>
        <LanguageToggle />
      </View>

      <Title title={t('auth.signIn.title')} subtitle={t('auth.signIn.subtitle')} />

      {phoneEnabled ? (
        <View style={styles.tabs} accessibilityRole="tablist">
          {(['email', 'phone'] as const).map((option) => (
            <Pressable
              key={option}
              accessibilityRole="tab"
              accessibilityState={{ selected: method === option }}
              onPress={() => setMethod(option)}
              style={[styles.tab, method === option ? styles.tabActive : null]}
            >
              <Text style={[styles.tabText, method === option ? styles.tabTextActive : null]}>
                {t(option === 'email' ? 'auth.method.email' : 'auth.method.phone')}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}

      {method === 'email' ? (
        <>
          <Field
            label={t('auth.field.email')}
            value={email}
            onChangeText={setEmail}
            error={fieldError('email')}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
          />
          <Field
            label={t('auth.field.password')}
            value={password}
            onChangeText={setPassword}
            error={fieldError('password')}
            autoCapitalize="none"
            autoComplete="current-password"
            secureTextEntry
          />
          <Button label={t('auth.signIn.submit')} loading={busy} onPress={() => void submit()} />
        </>
      ) : (
        <>
          <Field
            label={t('auth.field.phone')}
            value={phone}
            onChangeText={setPhone}
            error={fieldError('phone')}
            hint={t('validation.phone')}
            placeholder="+85512345678"
            autoComplete="tel"
            keyboardType="phone-pad"
          />
          <Button label={t('auth.sendCode')} loading={busy} onPress={() => void submit()} />
        </>
      )}

      <OAuthRow />

      <View style={styles.links}>
        <Link href="/forgot-password" style={styles.link}>
          {t('auth.forgot.link')}
        </Link>
        <Link href="/sign-up" style={styles.link}>
          {t('auth.signIn.createOne')}
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { fontSize: 17, fontWeight: '700', color: colors.text },
  tabs: { flexDirection: 'row', gap: 8 },
  tab: {
    flex: 1,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#bcc8be',
    backgroundColor: colors.surface,
  },
  tabActive: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  tabText: { fontSize: 14, fontWeight: '600', color: colors.muted },
  tabTextActive: { color: colors.brandDark },
  links: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 4 },
  link: { fontSize: 14, fontWeight: '500', color: colors.brandDark },
});
