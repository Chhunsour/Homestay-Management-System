import { useCallback, useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import {
  PAYMENT_METHODS,
  RECORDABLE_PAYMENT_TYPES,
  canOverridePayment,
  formatDateTime,
  formatMoney,
  paymentMethodKey,
  paymentTypeKey,
} from '@homestay/shared';
import type {
  BookingPaymentSummary,
  Payment,
  PaymentDuplicate,
  PaymentMethod,
  OverpaymentDetail,
  TranslationKey,
} from '@homestay/shared';
import { Banner, Button, Field, Screen, Title } from '@/components/ui';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { Loading } from '@/components/Loading';
import { PaymentSummary } from '@/components/PaymentSummary';
import { useSession } from '@/lib/session';
import { getBookingPaymentSummary, recordPayment } from '@/lib/payments';

/**
 * Recording money from the phone — the Messenger case: a screenshot arrives,
 * the owner types the amount and saves. A partial payment is a payment; only a
 * repeated transaction reference or an amount past the booking total stops the
 * save, and only an owner or manager is offered the override.
 */
export default function RecordPaymentScreen() {
  const { t, locale, business } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [summary, setSummary] = useState<BookingPaymentSummary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busy, setBusy] = useState(false);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('aba');
  const [paymentType, setPaymentType] = useState<Payment['payment_type']>('deposit');
  const [reference, setReference] = useState('');
  const [payerName, setPayerName] = useState('');
  const [note, setNote] = useState('');

  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [duplicates, setDuplicates] = useState<PaymentDuplicate[]>([]);
  const [overpayment, setOverpayment] = useState<OverpaymentDetail | null>(null);
  const [overrideReason, setOverrideReason] = useState('');

  const timezone = business?.timezone ?? 'Asia/Phnom_Penh';

  const load = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      setSummary(await getBookingPaymentSummary(id));
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // The amount owners type most often is what is still missing from the deposit.
  useEffect(() => {
    if (!summary || amount) return;
    const outstanding = Math.max(Number(summary.deposit_required) - Number(summary.net_paid), 0);
    if (outstanding > 0) setAmount(outstanding.toFixed(2));
    setPaymentType(Number(summary.net_paid) > 0 ? 'balance' : 'deposit');
  }, [summary]);

  if (!business) return null;

  const canOverride = canOverridePayment(business.role);
  const blocked = duplicates.length > 0 || overpayment !== null;

  async function save(): Promise<void> {
    if (!id) return;
    const value = Number(amount.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return setErrorKey('validation.price');
    if (blocked && canOverride && overrideReason.trim().length < 3) {
      return setErrorKey('payment.reason.required');
    }

    setErrorKey(null);
    setBusy(true);
    try {
      const result = await recordPayment(timezone, {
        bookingId: id,
        amount: value,
        method,
        paymentType,
        // Blank: the money is landing right now, which is why this is being typed.
        paidAt: '',
        reference: reference.trim(),
        payerName: payerName.trim(),
        note: note.trim(),
        duplicateOverride: blocked && canOverride && duplicates.length > 0,
        overpaymentOverride: blocked && canOverride && overpayment !== null,
        overrideReason: blocked && canOverride ? overrideReason.trim() : '',
      });

      setDuplicates(result.duplicates);
      setOverpayment(result.overpayment);
      if (result.errorKey) return setErrorKey(result.errorKey);

      // Straight to the payment, where the screenshot gets attached.
      if (result.id) router.replace(`/payment/${result.id}`);
      else router.back();
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

  if (state === 'failed' || !summary) {
    return (
      <Screen>
        <Banner tone="error">{t('error.network')}</Banner>
        <Button label={t('common.retry')} onPress={() => void load()} />
      </Screen>
    );
  }

  const excess = overpayment
    ? overpayment.net_paid + overpayment.amount - overpayment.booking_total
    : 0;

  return (
    <Screen>
      <Title title={t('payment.record.title')} />

      {errorKey && !blocked ? <Banner tone="error">{t(errorKey)}</Banner> : null}

      <PaymentSummary summary={summary} />

      {duplicates.length > 0 ? (
        <View style={styles.warning}>
          <Text style={styles.warningTitle}>{t('payment.duplicate.title')}</Text>
          {duplicates.map((duplicate) => (
            <Text key={duplicate.id} style={styles.warningBody}>
              {t('payment.duplicate.match', {
                number: duplicate.payment_number,
                amount: formatMoney(locale, Number(duplicate.amount), duplicate.currency),
                date: formatDateTime(locale, duplicate.paid_at, timezone),
              })}
            </Text>
          ))}
          <Text style={styles.warningBody}>
            {canOverride ? t('payment.duplicate.override') : t('payment.duplicate.forbidden')}
          </Text>
        </View>
      ) : null}

      {overpayment ? (
        <View style={styles.warning}>
          <Text style={styles.warningTitle}>{t('payment.overpayment.title')}</Text>
          <Text style={styles.warningBody}>
            {t('payment.overpayment.warning', {
              amount: formatMoney(locale, excess, overpayment.currency),
            })}
          </Text>
          <Text style={styles.warningBody}>
            {canOverride ? t('payment.overpayment.override') : t('payment.overpayment.forbidden')}
          </Text>
        </View>
      ) : null}

      {blocked && canOverride ? (
        <Field
          label={t('payment.override.reason')}
          hint={t('payment.reason.required')}
          value={overrideReason}
          onChangeText={setOverrideReason}
          maxLength={300}
        />
      ) : null}

      <Field
        label={t('payment.amount')}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        error={errorKey === 'validation.price' ? t('validation.price') : undefined}
      />

      <ChoiceGroup
        label={t('payment.method')}
        options={PAYMENT_METHODS}
        value={method}
        onChange={setMethod}
        renderLabel={(value) => t(paymentMethodKey(value))}
      />

      <ChoiceGroup
        label={t('payment.type')}
        options={RECORDABLE_PAYMENT_TYPES}
        value={paymentType}
        onChange={setPaymentType}
        renderLabel={(value) => t(paymentTypeKey(value))}
      />

      <Field
        label={t('payment.reference')}
        hint={t('payment.reference.hint')}
        value={reference}
        onChangeText={setReference}
        autoCapitalize="characters"
        maxLength={120}
      />
      <Field
        label={t('payment.payer')}
        hint={t('payment.payer.hint')}
        value={payerName}
        onChangeText={setPayerName}
        maxLength={160}
      />
      <Field
        label={t('payment.note')}
        value={note}
        onChangeText={setNote}
        multiline
        maxLength={1000}
      />

      <Button label={t('payment.record')} loading={busy} onPress={() => void save()} />
      <Button label={t('common.cancel')} variant="secondary" onPress={() => router.back()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  warning: {
    backgroundColor: '#fffbeb',
    borderColor: '#fde68a',
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    gap: 6,
  },
  warningTitle: { fontSize: 14, fontWeight: '600', color: '#92400e' },
  warningBody: { fontSize: 13, lineHeight: 20, color: '#92400e' },
});
