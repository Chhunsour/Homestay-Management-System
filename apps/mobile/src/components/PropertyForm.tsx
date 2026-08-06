import { useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Switch, Text, View } from 'react-native';
import {
  CURRENCIES,
  createPropertySchema,
  fieldErrors,
  propertyDetailsSchema,
  toTimeInput,
  type Currency,
  type PropertyWithDetails,
  type TranslationKey,
} from '@homestay/shared';
import { Banner, Button, Field, colors } from '@/components/ui';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { useSession } from '@/lib/session';
import { createProperty, updateProperty } from '@/lib/properties';

/**
 * One form for create and edit. On create it also collects the base rate,
 * because `create_property` writes the property and its pricing together.
 */
export function PropertyForm({ property }: { property?: PropertyWithDetails }) {
  const { t, business } = useSession();
  const editing = Boolean(property);

  const [name, setName] = useState(property?.name ?? '');
  const [description, setDescription] = useState(property?.description ?? '');
  const [phone, setPhone] = useState(property?.phone ?? '');
  const [address, setAddress] = useState(property?.address ?? '');
  const [mapLocation, setMapLocation] = useState(property?.map_location ?? '');
  const [latitude, setLatitude] = useState(property?.latitude?.toString() ?? '');
  const [longitude, setLongitude] = useState(property?.longitude?.toString() ?? '');
  const [checkInTime, setCheckInTime] = useState(
    toTimeInput(property?.default_check_in_time) || '14:00',
  );
  const [checkOutTime, setCheckOutTime] = useState(
    toTimeInput(property?.default_check_out_time) || '12:00',
  );
  const [isActive, setIsActive] = useState(property?.is_active ?? true);
  const [weekdayPrice, setWeekdayPrice] = useState('0');
  const [weekendPrice, setWeekendPrice] = useState('0');
  const [currency, setCurrency] = useState<Currency>(
    (business?.default_currency as Currency | undefined) ?? 'USD',
  );

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);

  const fieldError = (key: string): string | undefined => {
    const value = errors[key];
    return value ? t(value as TranslationKey) : undefined;
  };

  async function submit(): Promise<void> {
    if (!business) return;
    setErrors({});
    setErrorKey(null);
    setBusy(true);

    try {
      const details = {
        name,
        description,
        phone,
        address,
        mapLocation,
        latitude,
        longitude,
        checkInTime,
        checkOutTime,
        isActive,
      };

      if (property) {
        const parsed = propertyDetailsSchema.safeParse(details);
        if (!parsed.success) return setErrors(fieldErrors(parsed.error));

        const failed = await updateProperty(business.business_id, property.id, parsed.data);
        if (failed) return setErrorKey(failed);
        return router.back();
      }

      const parsed = createPropertySchema.safeParse({
        ...details,
        weekdayPrice,
        weekendPrice,
        currency,
      });
      if (!parsed.success) return setErrors(fieldErrors(parsed.error));

      const { id, errorKey: failed } = await createProperty(business.business_id, parsed.data);
      if (failed) return setErrorKey(failed);
      router.replace(id ? `/property/${id}` : '/(tabs)/properties');
    } catch {
      setErrorKey('error.network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}

      <Field
        label={t('property.field.name')}
        value={name}
        onChangeText={setName}
        error={fieldError('name')}
        maxLength={120}
      />
      <Field
        label={t('property.field.description')}
        value={description}
        onChangeText={setDescription}
        error={fieldError('description')}
        multiline
        numberOfLines={4}
      />
      <Field
        label={t('property.field.phone')}
        value={phone}
        onChangeText={setPhone}
        error={fieldError('phone')}
        hint={t('validation.phone')}
        keyboardType="phone-pad"
        autoCapitalize="none"
        placeholder="+85512345678"
      />
      <Field
        label={t('property.field.address')}
        value={address}
        onChangeText={setAddress}
        error={fieldError('address')}
      />
      <Field
        label={t('property.field.mapLocation')}
        value={mapLocation}
        onChangeText={setMapLocation}
        error={fieldError('mapLocation')}
        hint={t('property.field.mapLocation.hint')}
        autoCapitalize="none"
      />
      <Field
        label={t('property.field.latitude')}
        value={latitude}
        onChangeText={setLatitude}
        error={fieldError('latitude')}
        hint={t('property.field.coordinates.hint')}
        keyboardType="numbers-and-punctuation"
      />
      <Field
        label={t('property.field.longitude')}
        value={longitude}
        onChangeText={setLongitude}
        error={fieldError('longitude')}
        keyboardType="numbers-and-punctuation"
      />
      <Field
        label={t('property.field.checkIn')}
        value={checkInTime}
        onChangeText={setCheckInTime}
        error={fieldError('checkInTime')}
        placeholder="14:00"
        keyboardType="numbers-and-punctuation"
      />
      <Field
        label={t('property.field.checkOut')}
        value={checkOutTime}
        onChangeText={setCheckOutTime}
        error={fieldError('checkOutTime')}
        placeholder="12:00"
        keyboardType="numbers-and-punctuation"
      />

      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>{t('property.field.active')}</Text>
          <Text style={styles.switchHint}>{t('property.field.active.hint')}</Text>
        </View>
        <Switch
          accessibilityLabel={t('property.field.active')}
          value={isActive}
          onValueChange={setIsActive}
          trackColor={{ true: colors.brand, false: '#bcc8be' }}
        />
      </View>

      {editing ? null : (
        <>
          <Text style={styles.section}>{t('pricing.title')}</Text>
          <Text style={styles.sectionHint}>{t('pricing.subtitle')}</Text>
          <Field
            label={t('pricing.weekday')}
            value={weekdayPrice}
            onChangeText={setWeekdayPrice}
            error={fieldError('weekdayPrice')}
            keyboardType="decimal-pad"
          />
          <Field
            label={t('pricing.weekend')}
            value={weekendPrice}
            onChangeText={setWeekendPrice}
            error={fieldError('weekendPrice')}
            keyboardType="decimal-pad"
          />
          <ChoiceGroup
            label={t('pricing.currency')}
            options={CURRENCIES}
            value={currency}
            onChange={setCurrency}
            error={fieldError('currency')}
          />
        </>
      )}

      <Button
        label={t(editing ? 'common.save' : 'property.create.submit')}
        loading={busy}
        onPress={() => void submit()}
      />
      <Button label={t('common.cancel')} variant="secondary" onPress={() => router.back()} />
    </>
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchText: { flex: 1, gap: 2 },
  switchLabel: { fontSize: 14, fontWeight: '600', color: colors.text },
  switchHint: { fontSize: 12, lineHeight: 18, color: colors.muted },
  section: { fontSize: 18, fontWeight: '700', color: colors.text, paddingTop: 8 },
  sectionHint: { fontSize: 13, lineHeight: 20, color: colors.muted, marginTop: -12 },
});
