import { useCallback, useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Share, StyleSheet, Text } from 'react-native';
import {
  bookingPaymentStatusKey,
  createTranslator,
  formatDate,
  formatDateTime,
  formatMoney,
  paymentMethodKey,
} from '@homestay/shared';
import type { Receipt } from '@homestay/shared';
import { Banner, Button, Card, Empty, Row, Screen, Title, colors } from '@/components/ui';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { getReceipt } from '@/lib/payments';

/**
 * A receipt as issued. Every value comes from `snapshot`, written when the
 * receipt was created — renaming the property or fixing a guest's phone number
 * next month must not change a receipt somebody is already holding. The
 * language is the one chosen at issue time, not the reader's.
 *
 * ponytail: sharing is the OS share sheet with the receipt as text, which is
 * what actually reaches a guest on Messenger. A rendered PDF would mean a
 * layout engine on the phone; the web dashboard prints one when a guest wants
 * paper.
 */
export default function ReceiptScreen() {
  const { t: appT, business } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  const businessId = business?.business_id;
  const timezone = business?.timezone ?? 'Asia/Phnom_Penh';

  const load = useCallback(async (): Promise<void> => {
    if (!businessId || !id) return;
    try {
      setReceipt(await getReceipt(businessId, id));
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [businessId, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!business) return null;

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
        <Banner tone="error">{appT('error.network')}</Banner>
        <Button label={appT('common.retry')} onPress={() => void load()} />
      </Screen>
    );
  }

  if (!receipt) {
    return (
      <Screen>
        <Empty title={appT('receipt.notFound')} body={appT('payment.empty.body')} />
        <Button label={appT('common.back')} variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  const snapshot = receipt.snapshot;
  const locale = receipt.language;
  const t = createTranslator(locale);
  const zone = snapshot.timezone || timezone;
  const money = (value: number | null) =>
    value === null ? '—' : formatMoney(locale, Number(value), snapshot.currency);

  const lines = [
    snapshot.business_name,
    `${t('receipt.title')} ${receipt.receipt_number}`,
    `${t('booking.number')}: ${snapshot.booking_number}`,
    `${t('payment.customer')}: ${snapshot.customer_name}`,
    `${t('payment.property')}: ${snapshot.property_name}`,
    `${t('receipt.stay')}: ${formatDate(locale, snapshot.check_in_at, zone)} → ${formatDate(
      locale,
      snapshot.check_out_at,
      zone,
    )}`,
    snapshot.payment_amount === null
      ? null
      : `${t('payment.amount')}: ${money(snapshot.payment_amount)}`,
    `${t('payment.summary.total')}: ${money(snapshot.booking_total)}`,
    `${t('payment.summary.paid')}: ${money(snapshot.total_paid)}`,
    `${t('payment.summary.balance')}: ${money(snapshot.balance)}`,
    t('receipt.thanks'),
  ].filter((line): line is string => Boolean(line));

  return (
    <Screen>
      <Title title={t('receipt.title')} subtitle={receipt.receipt_number} />

      <Button
        label={t('receipt.share')}
        onPress={() => void Share.share({ message: lines.join('\n') })}
      />

      <Card>
        <Row label={t('receipt.issuedAt')} value={formatDateTime(locale, receipt.issued_at, zone)} />
        <Row label={t('receipt.issuedBy')} value={snapshot.issued_by_name} />
        <Row label={t('booking.number')} value={snapshot.booking_number} />
        <Row label={t('payment.customer')} value={snapshot.customer_name} />
        <Row label={t('customer.field.phone')} value={snapshot.customer_phone ?? '—'} />
        <Row label={t('payment.property')} value={snapshot.property_name} />
        <Row
          label={t('receipt.stay')}
          value={`${formatDate(locale, snapshot.check_in_at, zone)} → ${formatDate(
            locale,
            snapshot.check_out_at,
            zone,
          )}`}
        />
      </Card>

      {snapshot.payment_number ? (
        <Card>
          <Row label={t('payment.number')} value={snapshot.payment_number} />
          <Row label={t('payment.amount')} value={money(snapshot.payment_amount)} />
          <Row
            label={t('payment.method')}
            value={snapshot.payment_method ? t(paymentMethodKey(snapshot.payment_method)) : '—'}
          />
          <Row label={t('payment.reference')} value={snapshot.payment_reference ?? '—'} />
          <Row
            label={t('payment.date')}
            value={snapshot.payment_at ? formatDateTime(locale, snapshot.payment_at, zone) : '—'}
          />
        </Card>
      ) : null}

      <Card>
        <Row label={t('payment.summary.total')} value={money(snapshot.booking_total)} />
        <Row label={t('payment.summary.deposit')} value={money(snapshot.deposit_required)} />
        <Row label={t('payment.summary.paid')} value={money(snapshot.total_paid)} />
        {Number(snapshot.refund_total) > 0 ? (
          <Row label={t('payment.summary.refunded')} value={money(snapshot.refund_total)} />
        ) : null}
        <Row label={t('payment.summary.net')} value={money(snapshot.net_paid)} />
        <Row label={t('payment.summary.balance')} value={money(snapshot.balance)} />
        <Row
          label={t('payment.status')}
          value={t(bookingPaymentStatusKey(snapshot.payment_status))}
        />
      </Card>

      <Text style={styles.note}>{t('receipt.snapshot')}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 12, color: colors.muted, textAlign: 'center' },
});
