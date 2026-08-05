import { StyleSheet, Text, View } from 'react-native';
import {
  BOOKING_PAYMENT_COLORS,
  bookingPaymentStatusKey,
  formatMoney,
} from '@homestay/shared';
import type { BookingPaymentSummary } from '@homestay/shared';
import { Card, Row, StatusDot, colors } from '@/components/ui';
import { useSession } from '@/lib/session';

/**
 * What a booking owes, exactly as the database computed it. Nothing on this
 * screen adds anything up itself.
 */
export function PaymentSummary({ summary }: { summary: BookingPaymentSummary }) {
  const { t, locale } = useSession();
  const money = (value: number | string) =>
    formatMoney(locale, Number(value), summary.currency);
  const balance = Number(summary.balance);

  return (
    <>
      <View style={styles.head}>
        <Text style={styles.percent}>
          {t('payment.summary.percent', { percent: String(Math.round(Number(summary.paid_percent))) })}
        </Text>
        <View style={styles.status}>
          <StatusDot color={BOOKING_PAYMENT_COLORS[summary.payment_status]} />
          <Text style={styles.statusText}>{t(bookingPaymentStatusKey(summary.payment_status))}</Text>
        </View>
      </View>
      <Text style={styles.due}>
        {balance > 0
          ? t('payment.summary.due', { amount: money(balance) })
          : t('payment.summary.settled')}
      </Text>

      <Card>
        <Row label={t('payment.summary.total')} value={money(summary.booking_total)} />
        <Row label={t('payment.summary.deposit')} value={money(summary.deposit_required)} />
        <Row label={t('payment.summary.paid')} value={money(summary.total_paid)} />
        {Number(summary.refund_total) > 0 ? (
          <Row label={t('payment.summary.refunded')} value={money(summary.refund_total)} />
        ) : null}
        <Row label={t('payment.summary.net')} value={money(summary.net_paid)} />
        <Row label={t('payment.summary.balance')} value={money(summary.balance)} />
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 8,
  },
  percent: { fontSize: 16, fontWeight: '600', color: colors.text },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusText: { fontSize: 14, fontWeight: '500', color: colors.text },
  due: { fontSize: 13, color: colors.muted },
});
