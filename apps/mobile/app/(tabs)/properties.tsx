import { useCallback, useState } from 'react';
import { Link, router, useFocusEffect } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { can, formatMoney } from '@homestay/shared';
import type { PropertyWithDetails, TranslationKey } from '@homestay/shared';
import { Badge, Banner, Button, Empty, Field, Screen, Title, colors } from '@/components/ui';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { coverPhoto, listProperties, signedPhotoUrls, type PropertyFilter } from '@/lib/properties';

const FILTERS: readonly PropertyFilter[] = ['all', 'active', 'inactive'];
const FILTER_LABELS: Record<PropertyFilter, TranslationKey> = {
  all: 'common.all',
  active: 'property.filter.active',
  inactive: 'property.filter.inactive',
};

export default function PropertiesTab() {
  const { t, locale, business } = useSession();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<PropertyFilter>('all');
  const [properties, setProperties] = useState<PropertyWithDetails[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);

  const businessId = business?.business_id;

  const load = useCallback(async (): Promise<void> => {
    if (!businessId) return;
    setFailed(false);
    try {
      const rows = await listProperties(businessId, { search, filter });
      setProperties(rows);
      const covers = rows.map(coverPhoto).filter((photo) => photo !== null);
      setUrls(await signedPhotoUrls(covers.map((photo) => photo.storage_path)));
    } catch {
      setFailed(true);
      setProperties([]);
    }
  }, [businessId, search, filter]);

  // Reloads on every focus, so a save on the detail screen is visible on return.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!business) return null;
  const canManage = can(business.role, 'properties.manage');

  return (
    <Screen>
      <Title title={t('property.title')} subtitle={t('property.subtitle')} />

      {canManage ? (
        <Button label={t('property.new')} onPress={() => router.push('/property/new')} />
      ) : null}

      <Field
        label={t('property.search')}
        value={search}
        onChangeText={setSearch}
        onSubmitEditing={() => void load()}
        returnKeyType="search"
        autoCapitalize="none"
      />
      <ChoiceGroup
        label={t('common.all')}
        options={FILTERS}
        value={filter}
        onChange={setFilter}
        renderLabel={(option) => t(FILTER_LABELS[option])}
      />

      {failed ? <Banner tone="error">{t('error.network')}</Banner> : null}

      {properties === null ? (
        <Loading />
      ) : properties.length === 0 ? (
        <Empty
          title={t('property.empty.title')}
          body={
            search || filter !== 'all' ? t('property.empty.filtered') : t('property.empty.body')
          }
        />
      ) : (
        properties.map((property) => {
          const cover = coverPhoto(property);
          const url = cover ? urls[cover.storage_path] : undefined;
          return (
            <Link key={property.id} href={`/property/${property.id}`} asChild>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={property.name}
                style={({ pressed }) => [styles.card, pressed ? styles.cardPressed : null]}
              >
                {url ? (
                  <Image
                    source={{ uri: url }}
                    style={styles.cover}
                    accessibilityIgnoresInvertColors
                  />
                ) : null}
                <View style={styles.cardBody}>
                  <View style={styles.cardHead}>
                    <Text style={styles.cardTitle}>{property.name}</Text>
                    <Badge>
                      {property.is_active
                        ? t('property.status.active')
                        : t('property.status.inactive')}
                    </Badge>
                  </View>
                  <Text style={styles.cardMeta}>{property.address || t('common.notSet')}</Text>
                  <Text style={styles.cardPrice}>
                    {property.pricing
                      ? `${formatMoney(locale, property.pricing.weekday_price, property.pricing.currency)} ${t('pricing.perNight')}`
                      : t('pricing.missing')}
                  </Text>
                </View>
              </Pressable>
            </Link>
          );
        })
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
    overflow: 'hidden',
  },
  cardPressed: { opacity: 0.85 },
  cover: { width: '100%', height: 160, backgroundColor: '#e2e8f0' },
  cardBody: { padding: 14, gap: 4 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.text },
  cardMeta: { fontSize: 13, color: colors.muted },
  cardPrice: { fontSize: 14, color: colors.text },
});
