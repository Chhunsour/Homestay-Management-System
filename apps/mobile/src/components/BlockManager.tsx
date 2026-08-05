import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import {
  BLOCK_REASONS,
  fieldErrors,
  formatDateTime,
  propertyBlockSchema,
  zonedTimeToUtc,
} from '@homestay/shared';
import type { BlockReason, PropertyBlock, TranslationKey } from '@homestay/shared';
import { Badge, Banner, Button, Field, colors } from '@/components/ui';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { useSession } from '@/lib/session';
import { cancelBlock, createBlock } from '@/lib/properties';

const REASON_LABELS: Record<BlockReason, TranslationKey> = {
  maintenance: 'block.reason.maintenance',
  owner_use: 'block.reason.owner_use',
  renovation: 'block.reason.renovation',
  custom: 'block.reason.custom',
};

/** Date and time are separate fields so each gets a numeric keypad. */
function joined(date: string, time: string): string {
  return `${date.trim()}T${time.trim()}`;
}

export function BlockManager({
  propertyId,
  blocks,
  canManage,
  onChanged,
}: {
  propertyId: string;
  blocks: PropertyBlock[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const { t, locale, business } = useSession();

  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('14:00');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('12:00');
  const [reason, setReason] = useState<BlockReason>('maintenance');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);

  if (!business) return null;
  const { business_id: businessId, timezone } = business;

  const fieldError = (key: string): string | undefined => {
    const value = errors[key];
    return value ? t(value as TranslationKey) : undefined;
  };

  async function submit(): Promise<void> {
    setErrors({});
    setErrorKey(null);

    const parsed = propertyBlockSchema.safeParse({
      propertyId,
      startsAt: joined(startDate, startTime),
      endsAt: joined(endDate, endTime),
      reason,
      note,
    });
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));

    setBusy(true);
    try {
      // The fields collect wall-clock time; the column is an instant.
      const failed = await createBlock(businessId, {
        propertyId,
        startsAt: zonedTimeToUtc(parsed.data.startsAt, timezone).toISOString(),
        endsAt: zonedTimeToUtc(parsed.data.endsAt, timezone).toISOString(),
        reason: parsed.data.reason,
        note: parsed.data.note,
      });
      if (failed) return setErrorKey(failed);
      setStartDate('');
      setEndDate('');
      setNote('');
      onChanged();
    } catch {
      setErrorKey('error.network');
    } finally {
      setBusy(false);
    }
  }

  function confirmCancel(blockId: string): void {
    Alert.alert(t('block.cancel'), t('block.cancelConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.confirm'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const failed = await cancelBlock(businessId, blockId);
            if (failed) setErrorKey(failed);
            else onChanged();
          })();
        },
      },
    ]);
  }

  return (
    <View style={styles.wrapper}>
      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}

      {canManage ? (
        <>
          <Text style={styles.hint}>{t('block.timezoneNote', { timezone })}</Text>
          <View style={styles.pair}>
            <View style={styles.pairItem}>
              <Field
                label={t('block.field.start')}
                value={startDate}
                onChangeText={setStartDate}
                error={fieldError('startsAt')}
                placeholder="2026-08-20"
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <View style={styles.pairItem}>
              <Field
                label={t('property.field.checkIn')}
                value={startTime}
                onChangeText={setStartTime}
                placeholder="14:00"
                keyboardType="numbers-and-punctuation"
              />
            </View>
          </View>
          <View style={styles.pair}>
            <View style={styles.pairItem}>
              <Field
                label={t('block.field.end')}
                value={endDate}
                onChangeText={setEndDate}
                error={fieldError('endsAt')}
                placeholder="2026-08-22"
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <View style={styles.pairItem}>
              <Field
                label={t('property.field.checkOut')}
                value={endTime}
                onChangeText={setEndTime}
                placeholder="12:00"
                keyboardType="numbers-and-punctuation"
              />
            </View>
          </View>
          <ChoiceGroup
            label={t('block.field.reason')}
            options={BLOCK_REASONS}
            value={reason}
            onChange={setReason}
            renderLabel={(option) => t(REASON_LABELS[option])}
            error={fieldError('reason')}
          />
          <Field
            label={t('block.field.note')}
            value={note}
            onChangeText={setNote}
            error={fieldError('note')}
          />
          <Button
            label={t('block.new')}
            variant="secondary"
            loading={busy}
            onPress={() => void submit()}
          />
        </>
      ) : null}

      {blocks.length === 0 ? (
        <Text style={styles.empty}>{t('block.empty')}</Text>
      ) : (
        blocks.map((block) => (
          <View key={block.id} style={styles.block}>
            <View style={styles.blockHead}>
              <Text style={styles.blockRange}>
                {formatDateTime(locale, block.starts_at, timezone)} –{' '}
                {formatDateTime(locale, block.ends_at, timezone)}
              </Text>
              {block.status === 'cancelled' ? (
                <Text style={styles.cancelled}>{t('block.status.cancelled')}</Text>
              ) : (
                <Badge>{t('block.status.active')}</Badge>
              )}
            </View>
            <Text style={styles.blockMeta}>
              {t(REASON_LABELS[block.reason])}
              {block.note ? ` — ${block.note}` : ''}
            </Text>
            {canManage && block.status === 'active' ? (
              <Button
                label={t('block.cancel')}
                variant="ghost"
                onPress={() => confirmCancel(block.id)}
              />
            ) : null}
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 12 },
  hint: { fontSize: 12, color: '#64748b' },
  empty: { fontSize: 14, color: colors.muted },
  pair: { flexDirection: 'row', gap: 12 },
  pairItem: { flex: 1 },
  block: {
    gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    paddingTop: 10,
  },
  blockHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  blockRange: { flexShrink: 1, fontSize: 14, fontWeight: '500', color: colors.text },
  blockMeta: { fontSize: 13, color: colors.muted },
  cancelled: { fontSize: 12, color: colors.muted },
});
