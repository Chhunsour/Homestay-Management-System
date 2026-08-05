import { useState } from 'react';
import { Redirect } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import {
  CURRENCIES,
  DEFAULT_TIMEZONE,
  LOCALES,
  TIMEZONE_OPTIONS,
  createBusinessSchema,
  fieldErrors,
  type Currency,
  type Locale,
  type TranslationKey,
} from '@homestay/shared';
import { Banner, Button, Field, Screen, Title, colors } from '@/components/ui';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

const LOCALE_LABELS: Record<Locale, TranslationKey> = {
  en: 'common.english',
  km: 'common.khmer',
};

export default function OnboardingScreen() {
  const { ready, user, business, t, locale, setLocale, refresh } = useSession();

  const [name, setName] = useState('');
  const [ownerName, setOwnerName] = useState(
    typeof user?.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : '',
  );
  const [phone, setPhone] = useState('');
  const [language, setLanguage] = useState<Locale>(locale);
  const [currency, setCurrency] = useState<Currency>('USD');
  const [timezone, setTimezone] = useState<string>(DEFAULT_TIMEZONE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);

  if (!ready) return <Loading />;
  if (!user) return <Redirect href="/sign-in" />;
  if (business) return <Redirect href="/(tabs)" />;

  const fieldError = (key: string): string | undefined => {
    const value = errors[key];
    return value ? t(value as TranslationKey) : undefined;
  };

  async function submit(): Promise<void> {
    setErrors({});
    setErrorKey(null);
    setBusy(true);

    try {
      const parsed = createBusinessSchema.safeParse({
        name,
        ownerName,
        phone,
        language,
        currency,
        timezone,
      });
      if (!parsed.success) return setErrors(fieldErrors(parsed.error));

      // The RPC assigns the owner role server-side; the client never sends one.
      const { error } = await supabase.rpc('create_business', {
        p_name: parsed.data.name,
        p_owner_name: parsed.data.ownerName,
        p_phone: parsed.data.phone,
        p_language: parsed.data.language,
        p_currency: parsed.data.currency,
        p_timezone: parsed.data.timezone,
      });
      if (error) return setErrorKey('error.generic');

      await setLocale(parsed.data.language);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Text style={styles.brand}>{t('app.name')}</Text>
      <Title title={t('onboarding.title')} subtitle={t('onboarding.subtitle')} />

      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}

      <Field
        label={t('onboarding.field.businessName')}
        value={name}
        onChangeText={setName}
        error={fieldError('name')}
      />
      <Field
        label={t('onboarding.field.ownerName')}
        value={ownerName}
        onChangeText={setOwnerName}
        error={fieldError('ownerName')}
        autoComplete="name"
      />
      <Field
        label={t('onboarding.field.phone')}
        value={phone}
        onChangeText={setPhone}
        error={fieldError('phone')}
        hint={t('validation.phone')}
        placeholder="+85512345678"
        keyboardType="phone-pad"
        autoComplete="tel"
      />

      <ChoiceGroup
        label={t('onboarding.field.language')}
        options={LOCALES}
        value={language}
        onChange={setLanguage}
        renderLabel={(option) => t(LOCALE_LABELS[option])}
        error={fieldError('language')}
      />
      <ChoiceGroup
        label={t('onboarding.field.currency')}
        options={CURRENCIES}
        value={currency}
        onChange={setCurrency}
        error={fieldError('currency')}
      />
      <ChoiceGroup
        label={t('onboarding.field.timezone')}
        options={TIMEZONE_OPTIONS}
        value={timezone}
        onChange={setTimezone}
        error={fieldError('timezone')}
      />

      <View style={styles.actions}>
        <Button label={t('onboarding.submit')} loading={busy} onPress={() => void submit()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: { fontSize: 15, fontWeight: '600', color: colors.text },
  actions: { paddingTop: 4, paddingBottom: 24 },
});
