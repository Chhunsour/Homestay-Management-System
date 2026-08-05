import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Alert, StyleSheet, Text, View } from 'react-native';
import {
  CURRENCIES,
  can,
  fieldErrors,
  formatMoney,
  propertyPricingSchema,
  toTimeInput,
} from '@homestay/shared';
import type {
  Currency,
  PropertyBlock,
  PropertyWithDetails,
  TranslationKey,
} from '@homestay/shared';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  Field,
  Row,
  Screen,
  Title,
  colors,
} from '@/components/ui';
import { BlockManager } from '@/components/BlockManager';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { Loading } from '@/components/Loading';
import { PhotoManager } from '@/components/PhotoManager';
import { useSession } from '@/lib/session';
import {
  archiveProperty,
  getBlocks,
  getProperty,
  setPropertyActive,
  signedPhotoUrls,
  updatePricing,
} from '@/lib/properties';

export default function PropertyDetailScreen() {
  const { t, locale, business } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [property, setProperty] = useState<PropertyWithDetails | null>(null);
  const [blocks, setBlocks] = useState<PropertyBlock[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [savedKey, setSavedKey] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);

  // Pricing is edited inline; the fields fill in once the property loads.
  const [weekdayPrice, setWeekdayPrice] = useState('');
  const [weekendPrice, setWeekendPrice] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [priceErrors, setPriceErrors] = useState<Record<string, string>>({});

  const businessId = business?.business_id;

  const load = useCallback(async (): Promise<void> => {
    if (!businessId || !id) return;
    try {
      const [row, blockRows] = await Promise.all([
        getProperty(businessId, id),
        getBlocks(businessId, id),
      ]);
      setProperty(row);
      setBlocks(blockRows);
      setUrls(row ? await signedPhotoUrls(row.photos.map((photo) => photo.storage_path)) : {});
      if (row?.pricing) {
        setWeekdayPrice(String(row.pricing.weekday_price));
        setWeekendPrice(String(row.pricing.weekend_price));
        setCurrency(row.pricing.currency);
      }
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

  const canManage = can(business.role, 'properties.manage');
  const canPrice = can(business.role, 'properties.pricing.manage');
  const canPhotos = can(business.role, 'properties.photos.manage');
  const canBlocks = can(business.role, 'properties.blocks.manage');

  async function savePricing(): Promise<void> {
    if (!businessId || !property) return;
    setPriceErrors({});
    setErrorKey(null);
    setSavedKey(null);

    const parsed = propertyPricingSchema.safeParse({ weekdayPrice, weekendPrice, currency });
    if (!parsed.success) return setPriceErrors(fieldErrors(parsed.error));

    setBusy(true);
    try {
      const failed = await updatePricing(businessId, property.id, parsed.data);
      if (failed) return setErrorKey(failed);
      setSavedKey('pricing.updated');
      void load();
    } catch {
      setErrorKey('error.network');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(): Promise<void> {
    if (!businessId || !property) return;
    setErrorKey(null);
    setBusy(true);
    try {
      const failed = await setPropertyActive(businessId, property.id, !property.is_active);
      if (failed) return setErrorKey(failed);
      setSavedKey(property.is_active ? 'property.deactivated' : 'property.activated');
      void load();
    } catch {
      setErrorKey('error.network');
    } finally {
      setBusy(false);
    }
  }

  function confirmArchive(): void {
    if (!property) return;
    Alert.alert(t('property.archive.title'), t('property.archive.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('property.action.archive'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const failed = await archiveProperty(property.id);
            if (failed) setErrorKey(failed);
            else router.replace('/(tabs)/properties');
          })();
        },
      },
    ]);
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

  if (!property) {
    return (
      <Screen>
        <Empty title={t('property.notFound')} body={t('property.empty.body')} />
        <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.head}>
        <Title title={property.name} subtitle={property.address ?? undefined} />
        <Badge>
          {property.is_active ? t('property.status.active') : t('property.status.inactive')}
        </Badge>
      </View>

      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}
      {savedKey ? <Banner tone="success">{t(savedKey)}</Banner> : null}
      {canManage ? null : <Banner tone="info">{t('property.readOnly')}</Banner>}

      {canManage ? (
        <>
          <Button
            label={t('common.edit')}
            variant="secondary"
            onPress={() => router.push(`/property/${property.id}/edit`)}
          />
          <Button
            label={t(
              property.is_active ? 'property.action.deactivate' : 'property.action.activate',
            )}
            variant="secondary"
            loading={busy}
            onPress={() => void toggleActive()}
          />
        </>
      ) : null}

      <Text style={styles.section}>{t('property.section.details')}</Text>
      <Card>
        <Row label={t('property.field.phone')} value={property.phone || t('common.notSet')} />
        <Row
          label={t('property.field.description')}
          value={property.description || t('common.notSet')}
        />
        <Row
          label={t('property.field.mapLocation')}
          value={property.map_location || t('common.notSet')}
        />
        <Row
          label={t('property.field.checkIn')}
          value={toTimeInput(property.default_check_in_time)}
        />
        <Row
          label={t('property.field.checkOut')}
          value={toTimeInput(property.default_check_out_time)}
        />
      </Card>

      <Text style={styles.section}>{t('pricing.title')}</Text>
      <Text style={styles.sectionHint}>{t('pricing.subtitle')}</Text>
      {canPrice ? (
        <>
          <Field
            label={t('pricing.weekday')}
            value={weekdayPrice}
            onChangeText={setWeekdayPrice}
            error={
              priceErrors.weekdayPrice ? t(priceErrors.weekdayPrice as TranslationKey) : undefined
            }
            keyboardType="decimal-pad"
          />
          <Field
            label={t('pricing.weekend')}
            value={weekendPrice}
            onChangeText={setWeekendPrice}
            error={
              priceErrors.weekendPrice ? t(priceErrors.weekendPrice as TranslationKey) : undefined
            }
            keyboardType="decimal-pad"
          />
          <ChoiceGroup
            label={t('pricing.currency')}
            options={CURRENCIES}
            value={currency}
            onChange={setCurrency}
          />
          <Button
            label={t('common.save')}
            variant="secondary"
            loading={busy}
            onPress={() => void savePricing()}
          />
        </>
      ) : (
        <Card>
          <Row
            label={t('pricing.weekday')}
            value={
              property.pricing
                ? formatMoney(locale, property.pricing.weekday_price, property.pricing.currency)
                : t('pricing.missing')
            }
          />
          <Row
            label={t('pricing.weekend')}
            value={
              property.pricing
                ? formatMoney(locale, property.pricing.weekend_price, property.pricing.currency)
                : t('pricing.missing')
            }
          />
        </Card>
      )}

      <Text style={styles.section}>{t('photo.title')}</Text>
      <PhotoManager
        propertyId={property.id}
        photos={property.photos}
        urls={urls}
        canManage={canPhotos}
        onChanged={() => void load()}
      />

      <Text style={styles.section}>{t('block.title')}</Text>
      <Text style={styles.sectionHint}>{t('block.subtitle')}</Text>
      <BlockManager
        propertyId={property.id}
        blocks={blocks}
        canManage={canBlocks}
        onChanged={() => void load()}
      />

      {can(business.role, 'properties.archive') ? (
        <Button label={t('property.action.archive')} variant="ghost" onPress={confirmArchive} />
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
