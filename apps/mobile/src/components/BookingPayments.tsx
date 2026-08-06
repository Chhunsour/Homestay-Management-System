import { useCallback, useState } from 'react';
import { Link, router, useFocusEffect } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  can,
  formatDateTime,
  formatMoney,
  paymentMethodKey,
  paymentStatusKey,
} from '@homestay/shared';
import type { BookingPaymentSummary, PaymentWithDetails, Receipt } from '@homestay/shared';
import { Banner, Button, colors } from '@/components/ui';
import { Loading } from '@/components/Loading';
import { PaymentSummary } from '@/components/PaymentSummary';
import { useSession } from '@/lib/session';
import { getBookingPaymentSummary, listBookingPayments, listReceipts } from '@/lib/payments';

/** The money half of a booking: what is owed, what came in, what was issued. */
export function BookingPayments({ bookingId }: { bookingId: string }) {
  const { t, locale, business } = useSession();

  const [summary, setSummary] = useState<BookingPaymentSummary | null>(null);
  const [payments, setPayments] = useState<PaymentWithDetails[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  const businessId = business?.business_id;
  const timezone = business?.timezone ?? 'Asia/Phnom_Penh';

  const load = useCallback(async (): Promise<void> => {
    if (!businessId) return;
    try {
      const [row, list, issued] = await Promise.all([
        getBookingPaymentSummary(bookingId),
        listBookingPayments(businessId, bookingId),
        listReceipts(businessId, bookingId),
      ]);
      setSummary(row);
      setPayments(list);
      setReceipts(issued);
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [businessId, bookingId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!business) return null;

  if (state === 'loading') return <Loading />;
  if (state === 'failed' || !summary) {
    return <Banner tone="error">{t('error.network')}</Banner>;
  }

  return (
    <>
      <Text style={styles.section}>{t('payment.summary.title')}</Text>
      <PaymentSummary summary={summary} />

      {can(business.role, 'payments.manage') ? (
        <Button
          label={t('payment.record')}
          onPress={() => router.push(`/booking/${bookingId}/payment`)}
        />
      ) : null}

      <Text style={styles.section}>{t('payment.history.title')}</Text>
      {payments.length === 0 ? (
        <Text style={styles.muted}>{t('payment.history.empty')}</Text>
      ) : (
        payments.map((payment) => (
          <Link key={payment.id} href={`/payment/${payment.id}`} asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={payment.payment_number}
              style={({ pressed }) => [styles.card, pressed ? styles.cardPressed : null]}
            >
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>{payment.payment_number}</Text>
                <Text
                  style={[
                    styles.amount,
                    payment.status === 'voided' ? styles.voided : null,
                    payment.payment_type === 'refund' ? styles.refund : null,
                  ]}
                >
                  {`${payment.payment_type === 'refund' ? '−' : ''}${formatMoney(
                    locale,
                    Number(payment.amount),
                    payment.currency,
                  )}`}
                </Text>
              </View>
              <Text style={styles.muted}>
                {`${formatDateTime(locale, payment.paid_at, timezone)} · ${t(
                  paymentMethodKey(payment.method),
                )} · ${t(paymentStatusKey(payment.status))}`}
              </Text>
              {payment.proofs.length > 0 ? (
                <Text style={styles.muted}>{t('payment.proof.title')}</Text>
              ) : null}
            </Pressable>
          </Link>
        ))
      )}

      <Text style={styles.section}>{t('receipt.list')}</Text>
      {receipts.length === 0 ? (
        <Text style={styles.muted}>{t('receipt.empty')}</Text>
      ) : (
        receipts.map((receipt) => (
          <Link key={receipt.id} href={`/receipt/${receipt.id}`} asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={receipt.receipt_number}
              style={({ pressed }) => [styles.card, pressed ? styles.cardPressed : null]}
            >
              <Text style={styles.cardTitle}>{receipt.receipt_number}</Text>
              <Text style={styles.muted}>
                {formatDateTime(locale, receipt.issued_at, timezone)}
              </Text>
            </Pressable>
          </Link>
        ))
      )}
    </>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 18, fontWeight: '700', color: colors.text, paddingTop: 8 },
  muted: { fontSize: 13, color: colors.muted },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 5,
  },
  cardPressed: { opacity: 0.72 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { flexShrink: 1, fontSize: 16, fontWeight: '700', color: colors.text },
  amount: { fontSize: 15, fontWeight: '600', color: colors.text },
  voided: { textDecorationLine: 'line-through', color: colors.muted },
  refund: { color: colors.danger },
});
