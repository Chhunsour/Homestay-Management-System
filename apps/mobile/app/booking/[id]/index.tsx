import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Alert, StyleSheet, Text, View } from 'react-native';
import {
  can,
  findStatusByCode,
  formatDateTime,
  formatMoney,
  isOverridable,
  isPendingExpired,
  statusLabel,
} from '@homestay/shared';
import type {
  BookingConflict,
  BookingStatus,
  BookingWithDetails,
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
  StatusDot,
  Title,
  colors,
} from '@/components/ui';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { getBooking, listBookingStatuses, resolvePending, setBookingStatus } from '@/lib/bookings';

export default function BookingDetailScreen() {
  const { t, locale, business } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [booking, setBooking] = useState<BookingWithDetails | null>(null);
  const [statuses, setStatuses] = useState<BookingStatus[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [statusId, setStatusId] = useState('');
  const [conflicts, setConflicts] = useState<BookingConflict[]>([]);
  const [conflictReason, setConflictReason] = useState('');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [savedKey, setSavedKey] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);

  const businessId = business?.business_id;
  const timezone = business?.timezone ?? 'Asia/Phnom_Penh';

  const load = useCallback(async (): Promise<void> => {
    if (!businessId || !id) return;
    try {
      const [row, list] = await Promise.all([
        getBooking(businessId, id),
        listBookingStatuses(businessId),
      ]);
      setBooking(row);
      setStatuses(list);
      setStatusId(row?.status_id ?? '');
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

  async function changeStatus(nextStatusId: string, reason?: string): Promise<void> {
    if (!booking) return;
    setErrorKey(null);
    setSavedKey(null);
    setBusy(true);
    try {
      const result = await setBookingStatus(
        booking.id,
        nextStatusId,
        reason ? { reason } : undefined,
      );
      setConflicts(result.conflicts);
      if (result.errorKey) return setErrorKey(result.errorKey);
      setSavedKey('booking.updated');
      setConflictReason('');
      await load();
    } catch {
      setErrorKey('error.network');
    } finally {
      setBusy(false);
    }
  }

  async function resolve(action: 'keep' | 'release'): Promise<void> {
    if (!booking) return;
    setErrorKey(null);
    setSavedKey(null);
    setBusy(true);
    try {
      const result = await resolvePending(booking.id, action);
      if (result.errorKey) return setErrorKey(result.errorKey);
      setSavedKey(action === 'keep' ? 'booking.pending.kept' : 'booking.pending.released');
      await load();
    } catch {
      setErrorKey('error.network');
    } finally {
      setBusy(false);
    }
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

  if (!booking) {
    return (
      <Screen>
        <Empty title={t('booking.error.notFound')} body={t('booking.empty.body')} />
        <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  const canManage = can(business.role, 'bookings.manage');
  const canCancel = can(business.role, 'bookings.cancel');
  const canRestore = can(business.role, 'bookings.restore');
  const canResolve = can(business.role, 'bookings.pending.resolve');
  const canOverride = can(business.role, 'bookings.conflict.override');

  const cancelled = findStatusByCode(statuses, 'cancelled');
  const completed = findStatusByCode(statuses, 'completed');
  const pending = findStatusByCode(statuses, 'pending');
  const isCancelled = booking.status?.code === 'cancelled';
  const expired = isPendingExpired(booking, new Date());
  const overridable = isOverridable(conflicts) && canOverride;

  function confirmCancel(): void {
    if (!cancelled) return;
    Alert.alert(t('booking.cancel'), t('booking.cancel.confirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('booking.cancel'),
        style: 'destructive',
        onPress: () => void changeStatus(cancelled.id),
      },
    ]);
  }

  return (
    <Screen>
      <View style={styles.head}>
        <Title
          title={t('booking.detail.title', { number: booking.booking_number })}
          subtitle={booking.property?.name ?? ''}
        />
        {booking.status ? (
          <View style={styles.status}>
            <StatusDot color={booking.status.color} />
            <Text style={styles.statusText}>{statusLabel(booking.status, t)}</Text>
          </View>
        ) : null}
      </View>

      {errorKey && conflicts.length === 0 ? <Banner tone="error">{t(errorKey)}</Banner> : null}
      {savedKey ? <Banner tone="success">{t(savedKey)}</Banner> : null}
      {expired ? <Banner tone="error">{t('booking.pending.review.body')}</Banner> : null}
      {booking.conflict_override ? (
        <Banner tone="info">
          {`${t('booking.conflict.badge')} — ${
            booking.conflict_override_at
              ? t('booking.conflict.approved', {
                  date: formatDateTime(locale, booking.conflict_override_at, timezone),
                })
              : ''
          } ${booking.conflict_override_reason ?? ''}`}
        </Banner>
      ) : null}

      {canManage ? (
        <>
          <Button
            label={t('common.edit')}
            variant="secondary"
            onPress={() => router.push(`/booking/${booking.id}/edit`)}
          />
          <Button
            label={t('booking.duplicate')}
            variant="secondary"
            onPress={() => router.push(`/booking/new?from=${booking.id}`)}
          />
        </>
      ) : null}

      <Card>
        <Row label={t('booking.number')} value={booking.booking_number} />
        <Row label={t('booking.property')} value={booking.property?.name ?? ''} />
        <Row
          label={t('booking.customer')}
          value={`${booking.customer?.full_name ?? ''} · ${booking.customer?.phone ?? ''}`}
        />
        <Row
          label={t('booking.checkIn')}
          value={formatDateTime(locale, booking.check_in_at, timezone)}
        />
        <Row
          label={t('booking.checkOut')}
          value={formatDateTime(locale, booking.check_out_at, timezone)}
        />
        <Row
          label={t('booking.source')}
          value={t(`booking.source.${booking.source}` as TranslationKey)}
        />
        {booking.pending_expires_at && !expired ? (
          <Row
            label={t('booking.status.pending')}
            value={t('booking.pending.holds', {
              time: formatDateTime(locale, booking.pending_expires_at, timezone),
            })}
          />
        ) : null}
      </Card>

      <Card>
        <Row
          label={t('booking.price.calculated')}
          value={formatMoney(locale, booking.calculated_price, booking.currency)}
        />
        <Row
          label={t('booking.price.final')}
          value={
            <View style={styles.status}>
              <Text style={styles.statusText}>
                {formatMoney(locale, booking.final_price, booking.currency)}
              </Text>
              {booking.price_overridden ? <Badge>{t('booking.price.override.badge')}</Badge> : null}
            </View>
          }
        />
        {booking.price_override_reason ? (
          <Row label={t('booking.price.override.reason')} value={booking.price_override_reason} />
        ) : null}
      </Card>

      <Card>
        <Row label={t('booking.note')} value={booking.note || t('common.notSet')} />
        <Row
          label={t('booking.internalNote')}
          value={booking.internal_note || t('common.notSet')}
        />
      </Card>

      {canManage ? (
        <>
          <Text style={styles.section}>{t('booking.status')}</Text>

          {conflicts.length > 0 ? (
            <View style={styles.conflict}>
              <Text style={styles.conflictTitle}>{t('booking.conflict.title')}</Text>
              {conflicts.map((conflict) => (
                <Text key={conflict.id} style={styles.conflictBody}>
                  {conflict.kind === 'booking'
                    ? t('availability.conflict.booking', { number: conflict.label })
                    : conflict.label}
                </Text>
              ))}
              {overridable ? (
                <Field
                  label={t('booking.conflict.reason')}
                  hint={t('booking.conflict.override')}
                  value={conflictReason}
                  onChangeText={setConflictReason}
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
            label={t('booking.status')}
            options={statuses.map((status) => status.id)}
            value={statusId}
            onChange={setStatusId}
            renderLabel={(value) => {
              const found = statuses.find((status) => status.id === value);
              return found ? statusLabel(found, t) : '';
            }}
          />
          <Button
            label={t('common.save')}
            loading={busy}
            disabled={!statusId || statusId === booking.status_id}
            onPress={() =>
              void changeStatus(
                statusId,
                overridable && conflictReason ? conflictReason : undefined,
              )
            }
          />

          {completed && !isCancelled ? (
            <Button
              label={t('booking.complete')}
              variant="secondary"
              onPress={() => void changeStatus(completed.id)}
            />
          ) : null}
          {cancelled && canCancel && !isCancelled ? (
            <Button label={t('booking.cancel')} variant="secondary" onPress={confirmCancel} />
          ) : null}
          {pending && canRestore && isCancelled ? (
            <Button
              label={t('booking.restore')}
              variant="secondary"
              onPress={() => void changeStatus(pending.id)}
            />
          ) : null}
        </>
      ) : null}

      {expired && canResolve ? (
        <>
          <Text style={styles.section}>{t('booking.pending.review.title')}</Text>
          <Button
            label={t('booking.pending.keep')}
            variant="secondary"
            loading={busy}
            onPress={() => void resolve('keep')}
          />
          <Button
            label={t('booking.pending.release')}
            variant="secondary"
            loading={busy}
            onPress={() => void resolve('release')}
          />
        </>
      ) : null}

      <Text style={styles.audit}>
        {t('booking.audit', {
          created: formatDateTime(locale, booking.created_at, timezone),
          updated: formatDateTime(locale, booking.updated_at, timezone),
        })}
      </Text>
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
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusText: { fontSize: 14, fontWeight: '500', color: colors.text },
  section: { fontSize: 16, fontWeight: '600', color: colors.text, paddingTop: 8 },
  audit: { fontSize: 12, color: colors.muted, textAlign: 'center' },

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
});
