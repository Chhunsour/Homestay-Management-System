import { useCallback, useEffect, useState } from 'react';
import { Link, router, useFocusEffect } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CUSTOMER_FILTERS, can } from '@homestay/shared';
import type { Customer, CustomerFilter, TranslationKey } from '@homestay/shared';
import { Badge, Banner, Button, Empty, Field, Screen, Title, colors } from '@/components/ui';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { listCustomers } from '@/lib/customers';

const FILTER_LABELS: Record<CustomerFilter, TranslationKey> = {
  active: 'customer.filter.active',
  archived: 'customer.filter.archived',
  all: 'common.all',
};

export default function CustomersTab() {
  const { t, business } = useSession();

  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [filter, setFilter] = useState<CustomerFilter>('active');
  const [page, setPage] = useState(1);
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [failed, setFailed] = useState(false);

  const businessId = business?.business_id;

  // Typing must not fire a query per keystroke; the list settles 300ms later.
  useEffect(() => {
    const timer = setTimeout(() => {
      setTerm(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (): Promise<void> => {
    if (!businessId) return;
    setFailed(false);
    try {
      const result = await listCustomers(businessId, { search: term, filter, page });
      setCustomers(result.customers);
      setHasMore(result.hasMore);
    } catch {
      setFailed(true);
      setCustomers([]);
    }
  }, [businessId, term, filter, page]);

  // Reloads on every focus, so a save on the detail screen is visible on return.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!business) return null;
  const canManage = can(business.role, 'customers.manage');

  return (
    <Screen>
      <Title title={t('customer.title')} subtitle={t('customer.subtitle')} />

      {canManage ? (
        <Button label={t('customer.new')} onPress={() => router.push('/customer/new')} />
      ) : null}

      <Field
        label={t('customer.search')}
        value={search}
        onChangeText={setSearch}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <ChoiceGroup
        label={t('common.all')}
        options={CUSTOMER_FILTERS}
        value={filter}
        onChange={(next) => {
          setFilter(next);
          setPage(1);
        }}
        renderLabel={(option) => t(FILTER_LABELS[option])}
      />

      {failed ? <Banner tone="error">{t('error.network')}</Banner> : null}

      {customers === null ? (
        <Loading />
      ) : customers.length === 0 ? (
        <Empty
          title={t('customer.empty.title')}
          body={
            term || filter !== 'active' ? t('customer.empty.filtered') : t('customer.empty.body')
          }
        />
      ) : (
        <>
          {customers.map((customer) => (
            <Link key={customer.id} href={`/customer/${customer.id}`} asChild>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={customer.full_name}
                style={({ pressed }) => [styles.card, pressed ? styles.cardPressed : null]}
              >
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>{customer.full_name}</Text>
                  {customer.archived_at ? <Badge>{t('customer.status.archived')}</Badge> : null}
                </View>
                <Text style={styles.cardMeta}>{customer.phone}</Text>
                {customer.facebook_name || customer.telegram_username ? (
                  <Text style={styles.cardMeta}>
                    {[
                      customer.facebook_name,
                      customer.telegram_username ? `@${customer.telegram_username}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                ) : null}
              </Pressable>
            </Link>
          ))}

          <Text style={styles.count}>
            {t('customer.count', { count: String(customers.length) })}
          </Text>
          {hasMore ? (
            <Button
              label={t('customer.more')}
              variant="secondary"
              onPress={() => setPage((current) => current + 1)}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 14,
    gap: 4,
  },
  cardPressed: { opacity: 0.85 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.text },
  cardMeta: { fontSize: 13, color: colors.muted },
  count: { fontSize: 13, color: colors.muted, textAlign: 'center' },
});
