import { StyleSheet, Text, View } from 'react-native';
import { formatDate } from '@homestay/shared';
import { Button, Card, Row, Screen, Title, colors } from '@/components/ui';
import { LanguageToggle } from '@/components/LanguageToggle';
import { useSession } from '@/lib/session';

export default function SettingsTab() {
  const { t, locale, user, business, signOut } = useSession();
  if (!business) return null;

  return (
    <Screen>
      <Title title={t('settings.title')} />

      <View style={styles.block}>
        <Text style={styles.heading}>{t('settings.language.title')}</Text>
        <Text style={styles.body}>{t('settings.language.body')}</Text>
        <LanguageToggle />
      </View>

      <Text style={styles.heading}>{t('settings.business.title')}</Text>
      <Card>
        <Row label={t('dashboard.business')} value={business.business_name} />
        <Row label={t('settings.business.currency')} value={business.default_currency} />
        <Row label={t('settings.business.timezone')} value={business.timezone} />
        <Row label={t('dashboard.role')} value={t(`role.${business.role}`)} />
      </Card>

      <Text style={styles.heading}>{t('settings.account.title')}</Text>
      <Card>
        <Row label={t('settings.account.email')} value={user?.email ?? '—'} />
        <Row label={t('settings.account.phone')} value={user?.phone || '—'} />
        <Row
          label={t('settings.account.memberSince')}
          value={user ? formatDate(locale, user.created_at) : '—'}
        />
      </Card>

      <View style={styles.actions}>
        <Button label={t('common.signOut')} variant="secondary" onPress={() => void signOut()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  heading: { fontSize: 14, fontWeight: '600', color: colors.text },
  body: { fontSize: 14, lineHeight: 21, color: colors.muted },
  actions: { paddingTop: 4, paddingBottom: 24 },
});
