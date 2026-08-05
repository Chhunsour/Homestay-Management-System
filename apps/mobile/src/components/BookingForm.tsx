import { useMemo, useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import {
  BOOKING_SOURCES,
  bookingSchema,
  fieldErrors,
  formatMoney,
  isOverridable,
  priceBooking,
  statusLabel,
  utcToZonedInput,
  zonedTimeToUtc,
} from '@homestay/shared';
import type {
  BookingConflict,
  BookingSource,
  BookingStatus,
  BookingWithDetails,
  Customer,
  Property,
  PropertyPricing,
  TranslationKey,
} from '@homestay/shared';
import { Banner, Button, Field, colors } from '@/components/ui';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { useSession } from '@/lib/session';
import { saveBooking } from '@/lib/bookings';

/** Enough to name it, seed its times and preview a price; `PropertyWithDetails` fits. */
export type PropertyOption = Pick<Property, 'id' | 'name'> & {
  default_check_in_time?: string;
  default_check_out_time?: string;
  pricing?: PropertyPricing | null;
};

/** How many guests the picker shows before the search box is the only way through. */
const CUSTOMER_LIMIT = 8;

/** `2026-08-10T14:00` split into the two fields a phone keyboard can type. */
function splitLocal(value: string): { date: string; time: string } {
  const [date = '', time = ''] = value.split('T');
  return { date, time };
}

/**
 * One form for the quick entry, the full create and the edit. Required: property,
 * guest, check-in, check-out — the rest is what someone fills in after the phone
 * call ends.
 *
 * The price shown is a preview from the same `priceBooking()` the web app uses.
 * The database recomputes it inside `save_booking`, so this number never decides
 * what is stored.
 */
export function BookingForm({
  booking,
  properties,
  customers,
  statuses,
  canOverridePrice,
  canOverrideConflict,
}: {
  booking?: BookingWithDetails;
  properties: PropertyOption[];
  customers: Pick<Customer, 'id' | 'full_name' | 'phone'>[];
  statuses: BookingStatus[];
  canOverridePrice: boolean;
  canOverrideConflict: boolean;
}) {
  const { t, locale, business } = useSession();
  const timezone = business?.timezone ?? 'Asia/Phnom_Penh';
  const editing = Boolean(booking?.id);

  const initialIn = booking ? splitLocal(utcToZonedInput(booking.check_in_at, timezone)) : null;
  const initialOut = booking ? splitLocal(utcToZonedInput(booking.check_out_at, timezone)) : null;

  const [propertyId, setPropertyId] = useState(booking?.property_id ?? properties[0]?.id ?? '');
  const [customerId, setCustomerId] = useState(booking?.customer_id ?? '');
  const [customerSearch, setCustomerSearch] = useState('');
  const [newCustomer, setNewCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [checkInDate, setCheckInDate] = useState(initialIn?.date ?? '');
  const [checkInTime, setCheckInTime] = useState(initialIn?.time ?? '');
  const [checkOutDate, setCheckOutDate] = useState(initialOut?.date ?? '');
  const [checkOutTime, setCheckOutTime] = useState(initialOut?.time ?? '');
  const [statusId, setStatusId] = useState(booking?.status_id ?? '');
  const [source, setSource] = useState<BookingSource>(booking?.source ?? 'other');
  const [note, setNote] = useState(booking?.note ?? '');
  const [internalNote, setInternalNote] = useState(booking?.internal_note ?? '');
  const [overridePrice, setOverridePrice] = useState(booking?.price_overridden ?? false);
  const [finalPrice, setFinalPrice] = useState(
    booking?.price_overridden ? String(booking.final_price) : '',
  );
  const [priceReason, setPriceReason] = useState(booking?.price_override_reason ?? '');
  const [conflicts, setConflicts] = useState<BookingConflict[]>([]);
  const [conflictReason, setConflictReason] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);

  const property = properties.find((row) => row.id === propertyId);

  /** The property's own times, so nobody types 14:00 forty times a week. */
  function pickProperty(id: string): void {
    setPropertyId(id);
    const next = properties.find((row) => row.id === id);
    if (!next) return;
    if (!checkInTime && next.default_check_in_time)
      setCheckInTime(next.default_check_in_time.slice(0, 5));
    if (!checkOutTime && next.default_check_out_time)
      setCheckOutTime(next.default_check_out_time.slice(0, 5));
  }

  const checkInAt = checkInDate && checkInTime ? `${checkInDate}T${checkInTime}` : '';
  const checkOutAt = checkOutDate && checkOutTime ? `${checkOutDate}T${checkOutTime}` : '';

  const preview = useMemo(
    () =>
      property?.pricing && checkInAt && checkOutAt && checkOutAt > checkInAt
        ? priceBooking(
            property.pricing,
            zonedTimeToUtc(checkInAt, timezone),
            zonedTimeToUtc(checkOutAt, timezone),
            timezone,
          )
        : null,
    [property, checkInAt, checkOutAt, timezone],
  );

  const term = customerSearch.trim().toLowerCase();
  const shownCustomers = customers
    .filter(
      (customer) =>
        !term ||
        customer.full_name.toLowerCase().includes(term) ||
        customer.phone.replace(/\s/g, '').includes(term.replace(/\s/g, '')),
    )
    .slice(0, CUSTOMER_LIMIT);

  const fieldError = (key: string): string | undefined => {
    const value = errors[key];
    return value ? t(value as TranslationKey) : undefined;
  };

  const overridable = isOverridable(conflicts) && canOverrideConflict;
  // Changing the dates under a manual price silently changes what a guest owes,
  // so it gets called out rather than quietly recalculated.
  const priceWarning = booking?.price_overridden && !overridePrice;

  async function submit(): Promise<void> {
    if (!business) return;
    setErrors({});
    setErrorKey(null);
    setBusy(true);

    try {
      const parsed = bookingSchema.safeParse({
        propertyId,
        customerId: newCustomer ? '' : customerId,
        newCustomerName: newCustomer ? newCustomerName : '',
        newCustomerPhone: newCustomer ? newCustomerPhone : '',
        checkInAt,
        checkOutAt,
        statusId,
        source,
        note,
        internalNote,
        finalPrice: overridePrice ? finalPrice : '',
        priceOverrideReason: overridePrice ? priceReason : '',
        conflictOverride: overridable && conflictReason.length > 0,
        conflictOverrideReason: overridable ? conflictReason : '',
      });
      if (!parsed.success) return setErrors(fieldErrors(parsed.error));

      const result = await saveBooking(
        business.business_id,
        timezone,
        parsed.data,
        booking?.id || null,
      );
      setConflicts(result.conflicts);
      if (result.errorKey) return setErrorKey(result.errorKey);

      const id = result.id ?? booking?.id;
      router.replace(id ? `/booking/${id}` : '/(tabs)/bookings');
    } catch {
      setErrorKey('error.network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {errorKey && conflicts.length === 0 ? <Banner tone="error">{t(errorKey)}</Banner> : null}

      {conflicts.length > 0 ? (
        <View style={styles.conflict}>
          <Text style={styles.conflictTitle}>{t('booking.conflict.title')}</Text>
          <Text style={styles.conflictBody}>{t('booking.conflict.body')}</Text>
          {conflicts.map((conflict) => (
            <Text key={conflict.id} style={styles.conflictBody}>
              {conflict.kind === 'booking'
                ? t('availability.conflict.booking', { number: conflict.label })
                : conflict.label}
              {conflict.starts_at && conflict.ends_at
                ? ` — ${t('booking.conflict.range', {
                    start: utcToZonedInput(conflict.starts_at, timezone).replace('T', ' '),
                    end: utcToZonedInput(conflict.ends_at, timezone).replace('T', ' '),
                  })}`
                : ''}
            </Text>
          ))}
          {overridable ? (
            <Field
              label={t('booking.conflict.reason')}
              hint={t('booking.conflict.override')}
              value={conflictReason}
              onChangeText={setConflictReason}
              error={fieldError('conflictOverrideReason')}
              maxLength={300}
            />
          ) : (
            <Text style={styles.conflictTitle}>
              {isOverridable(conflicts)
                ? t('booking.conflict.forbidden')
                : t('booking.error.propertyUnavailable')}
            </Text>
          )}
        </View>
      ) : null}

      <ChoiceGroup
        label={t('booking.property')}
        options={properties.map((row) => row.id)}
        value={propertyId}
        onChange={pickProperty}
        renderLabel={(id) => properties.find((row) => row.id === id)?.name ?? ''}
        error={fieldError('propertyId')}
      />

      {newCustomer ? (
        <>
          <Field
            label={t('booking.customer.name')}
            value={newCustomerName}
            onChangeText={setNewCustomerName}
            error={fieldError('newCustomerName')}
            maxLength={160}
          />
          <Field
            label={t('booking.customer.phone')}
            value={newCustomerPhone}
            onChangeText={setNewCustomerPhone}
            error={fieldError('newCustomerPhone')}
            keyboardType="phone-pad"
            autoCapitalize="none"
            placeholder="012 345 678"
            maxLength={32}
          />
          <Button
            label={t('booking.customer.existing')}
            variant="ghost"
            onPress={() => setNewCustomer(false)}
          />
        </>
      ) : (
        <>
          <Field
            label={t('booking.customer')}
            value={customerSearch}
            onChangeText={setCustomerSearch}
            autoCapitalize="none"
            autoCorrect={false}
            error={fieldError('customerId')}
          />
          <ChoiceGroup
            label={t('common.search')}
            options={shownCustomers.map((customer) => customer.id)}
            value={customerId}
            onChange={setCustomerId}
            renderLabel={(id) => {
              const found = customers.find((customer) => customer.id === id);
              return found ? `${found.full_name} · ${found.phone}` : '';
            }}
          />
          {/* The guest is on the phone now; sending staff to another screen loses them. */}
          <Button
            label={t('booking.customer.new')}
            variant="ghost"
            onPress={() => setNewCustomer(true)}
          />
        </>
      )}

      <Field
        label={`${t('booking.checkIn')} — ${t('booking.field.date')}`}
        value={checkInDate}
        onChangeText={setCheckInDate}
        error={fieldError('checkInAt')}
        placeholder="2026-08-10"
        keyboardType="numbers-and-punctuation"
        autoCapitalize="none"
        maxLength={10}
      />
      <Field
        label={`${t('booking.checkIn')} — ${t('booking.field.time')}`}
        value={checkInTime}
        onChangeText={setCheckInTime}
        placeholder="14:00"
        keyboardType="numbers-and-punctuation"
        maxLength={5}
      />
      <Field
        label={`${t('booking.checkOut')} — ${t('booking.field.date')}`}
        value={checkOutDate}
        onChangeText={setCheckOutDate}
        error={fieldError('checkOutAt')}
        placeholder="2026-08-12"
        keyboardType="numbers-and-punctuation"
        autoCapitalize="none"
        maxLength={10}
      />
      <Field
        label={`${t('booking.checkOut')} — ${t('booking.field.time')}`}
        value={checkOutTime}
        onChangeText={setCheckOutTime}
        placeholder="12:00"
        keyboardType="numbers-and-punctuation"
        maxLength={5}
      />

      {preview ? (
        <View style={styles.preview}>
          <Text style={styles.previewTotal}>
            {`${t('booking.price.calculated')}: ${formatMoney(
              locale,
              preview.total,
              preview.currency,
            )}`}
          </Text>
          <Text style={styles.previewMeta}>
            {`${t('booking.days', { count: String(preview.days.length) })} · ${t(
              'booking.price.breakdown',
              {
                weekdayCount: String(preview.weekdayCount),
                weekendCount: String(preview.weekendCount),
              },
            )}`}
          </Text>
        </View>
      ) : null}

      {priceWarning ? <Banner tone="info">{t('booking.price.override.warning')}</Banner> : null}

      <ChoiceGroup
        label={t('booking.status')}
        options={['', ...statuses.map((status) => status.id)]}
        value={statusId}
        onChange={setStatusId}
        renderLabel={(id) => {
          const found = statuses.find((status) => status.id === id);
          return found ? statusLabel(found, t) : t('booking.status.pending');
        }}
      />
      <ChoiceGroup
        label={t('booking.source')}
        options={BOOKING_SOURCES}
        value={source}
        onChange={setSource}
        renderLabel={(option) => t(`booking.source.${option}` as TranslationKey)}
      />

      {canOverridePrice ? (
        <>
          <Button
            label={t('booking.price.override')}
            variant={overridePrice ? 'primary' : 'secondary'}
            onPress={() => setOverridePrice((current) => !current)}
          />
          {overridePrice ? (
            <>
              <Field
                label={t('booking.price.final')}
                value={finalPrice}
                onChangeText={setFinalPrice}
                error={fieldError('finalPrice')}
                keyboardType="decimal-pad"
              />
              <Field
                label={t('booking.price.override.reason')}
                value={priceReason}
                onChangeText={setPriceReason}
                error={fieldError('priceOverrideReason')}
                maxLength={300}
              />
            </>
          ) : null}
        </>
      ) : null}

      <Field
        label={t('booking.note')}
        value={note}
        onChangeText={setNote}
        error={fieldError('note')}
        multiline
        numberOfLines={3}
        maxLength={2000}
      />
      <Field
        label={t('booking.internalNote')}
        hint={t('booking.internalNote.hint')}
        value={internalNote}
        onChangeText={setInternalNote}
        error={fieldError('internalNote')}
        multiline
        numberOfLines={3}
        maxLength={2000}
      />

      <Button
        label={t(editing ? 'common.save' : 'booking.new')}
        loading={busy}
        onPress={() => void submit()}
      />
      <Button label={t('common.cancel')} variant="secondary" onPress={() => router.back()} />
    </>
  );
}

const styles = StyleSheet.create({
  conflict: {
    backgroundColor: '#fffbeb',
    borderColor: '#fde68a',
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    gap: 6,
  },
  conflictTitle: { fontSize: 14, fontWeight: '600', color: '#92400e' },
  conflictBody: { fontSize: 13, lineHeight: 20, color: '#92400e' },

  preview: {
    backgroundColor: colors.canvas,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    gap: 4,
  },
  previewTotal: { fontSize: 15, fontWeight: '600', color: colors.text },
  previewMeta: { fontSize: 13, color: colors.muted },
});
