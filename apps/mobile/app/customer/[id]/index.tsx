import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { can, formatDate } from '@homestay/shared';
import type { Customer, CustomerNote, TranslationKey } from '@homestay/shared';
import { Badge, Banner, Button, Card, Empty, Row, Screen, Title, colors } from '@/components/ui';
import { CustomerNotes } from '@/components/CustomerNotes';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { getCustomer, listCustomerNotes, setCustomerArchived } from '@/lib/customers';

export default function CustomerDetailScreen() {
  const { t, locale, business } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [notes, setNotes] = useState<CustomerNote[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [savedKey, setSavedKey] = useState<TranslationKey | null>(null);

  const businessId = business?.business_id;

  const load = useCallback(async (): Promise<void> => {
    if (!businessId || !id) return;
    try {
      const row = await getCustomer(businessId, id);
      setCustomer(row);
      setNotes(row ? await listCustomerNotes(businessId, row.id) : []);
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [businessId, id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!business) return null;

  const canManage = can(business.role, 'customers.manage');
  const canArchive = can(business.role, 'customers.archive');
  const canRemoveNotes = can(business.role, 'customers.notes.manage');

  function confirmArchive(archived: boolean): void {
    if (!customer) return;
    Alert.alert(
      t(archived ? 'customer.archive.title' : 'customer.restore.title'),
      t(archived ? 'customer.archive.body' : 'customer.restore.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t(archived ? 'customer.action.archive' : 'customer.action.restore'),
          style: archived ? 'destructive' : 'default',
          onPress: () => {
            void (async () => {
              setErrorKey(null);
              const failed = await setCustomerArchived(customer.id, archived);
              if (failed) return setErrorKey(failed);
              setSavedKey(archived ? 'customer.archived' : 'customer.restored');
              void load();
            })();
          },
        },
      ],
    );
  }

  if (state === 'loading') {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }

  if (state === 'failed') {
    return (
      <Screen>
        <Banner tone="error">{t('error.network')}</Banner>
        <Button label={t('common.retry')} onPress={() => void load()} />
      </Screen>
    );
  }

  if (!customer) {
    return (
      <Screen>
        <Empty title={t('customer.notFound')} body={t('customer.empty.body')} />
        <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  const archived = customer.archived_at !== null;

  return (
    <Screen>
      <View style={styles.head}>
        <Title title={customer.full_name} subtitle={customer.phone} />
        <Badge>{t(archived ? 'customer.status.archived' : 'customer.status.active')}</Badge>
      </View>

      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}
      {savedKey ? <Banner tone="success">{t(savedKey)}</Banner> : null}
      {archived ? <Banner tone="info">{t('customer.archivedNotice')}</Banner> : null}
      {canArchive ? null : <Banner tone="info">{t('customer.readOnly')}</Banner>}

      {canManage && !archived ? (
        <Button
          label={t('common.edit')}
          variant="secondary"
          onPress={() => router.push(`/customer/${customer.id}/edit`)}
        />
      ) : null}

      <Text style={styles.section}>{t('customer.section.contact')}</Text>
      <Card>
        <Row label={t('customer.field.phone')} value={customer.phone} />
        <Row
          label={t('customer.field.phoneSecondary')}
          value={customer.phone_secondary || t('common.notSet')}
        />
        <Row label={t('customer.field.email')} value={customer.email || t('common.notSet')} />
        <Row
          label={t('customer.field.facebookName')}
          value={customer.facebook_name || t('common.notSet')}
        />
        <Row
          label={t('customer.field.telegram')}
          value={customer.telegram_username ? `@${customer.telegram_username}` : t('common.notSet')}
        />
        <Row
          label={t('customer.field.language')}
          value={t(customer.preferred_language === 'km' ? 'common.khmer' : 'common.english')}
        />
        <Row label={t('customer.field.address')} value={customer.address || t('common.notSet')} />
        <Row label={t('customer.field.note')} value={customer.note || t('common.notSet')} />
        <Row
          label={t('customer.field.created')}
          value={formatDate(locale, customer.created_at, business.timezone)}
        />
      </Card>

      <Text style={styles.section}>{t('customer.notes.title')}</Text>
      <Text style={styles.sectionHint}>{t('customer.notes.subtitle')}</Text>
      <CustomerNotes
        customerId={customer.id}
        notes={notes}
        canAdd={canManage && !archived}
        canRemove={canRemoveNotes}
        onChanged={() => void load()}
      />

      <Text style={styles.section}>{t('customer.history.title')}</Text>
      {/* Real bookings and payments arrive in a later phase. Placeholder rows
          would only teach staff to distrust the screen. */}
      <Empty title={t('customer.history.empty')} body={t('customer.history.body')} />

      {canArchive ? (
        <Button
          label={t(archived ? 'customer.action.restore' : 'customer.action.archive')}
          variant="ghost"
          onPress={() => confirmArchive(!archived)}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  section: { fontSize: 16, fontWeight: '600', color: colors.text, paddingTop: 8 },
  sectionHint: { fontSize: 13, lineHeight: 20, color: colors.muted, marginTop: -12 },
});
