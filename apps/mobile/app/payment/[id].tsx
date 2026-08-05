import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Image, Linking, StyleSheet, Text, View } from 'react-native';
import {
  LOCALES,
  canCorrectPayment,
  canRefundPayment,
  canVerifyPayment,
  canVoidPayment,
  formatDateTime,
  formatMoney,
  paymentMethodKey,
  paymentStatusKey,
  paymentTypeKey,
} from '@homestay/shared';
import type { Locale, PaymentWithDetails, TranslationKey } from '@homestay/shared';
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
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import {
  correctPayment,
  getPayment,
  issueReceipt,
  refundPayment,
  signedProofUrls,
  uploadProof,
  verifyPayment,
  voidPayment,
} from '@/lib/payments';

type Panel = 'correct' | 'refund' | 'void' | 'receipt' | null;

/**
 * One payment: what it was, what happened to it, and the screenshot that proves
 * it. Nothing here deletes — a void keeps the row and stops it counting, a
 * correction keeps the old amount, a refund is its own row. Which buttons show
 * is decided by the role; whether they work is decided by the database.
 */
export default function PaymentDetailScreen() {
  const { t, locale, business } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [payment, setPayment] = useState<PaymentWithDetails | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [savedKey, setSavedKey] = useState<TranslationKey | null>(null);

  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [receiptLanguage, setReceiptLanguage] = useState<Locale>(locale);

  const businessId = business?.business_id;
  const timezone = business?.timezone ?? 'Asia/Phnom_Penh';

  const load = useCallback(async (): Promise<void> => {
    if (!businessId || !id) return;
    try {
      const row = await getPayment(businessId, id);
      setPayment(row);
      setUrls(await signedProofUrls((row?.proofs ?? []).map((proof) => proof.storage_path)));
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

  async function run(
    action: () => Promise<{ errorKey: TranslationKey | null; id?: string | null }>,
    doneKey: TranslationKey,
  ): Promise<void> {
    setErrorKey(null);
    setSavedKey(null);
    setBusy(true);
    try {
      const result = await action();
      if (result.errorKey) return setErrorKey(result.errorKey);
      setSavedKey(doneKey);
      setPanel(null);
      setReason('');
      await load();
    } catch {
      setErrorKey('error.network');
    } finally {
      setBusy(false);
    }
  }

  async function pickAndUpload(): Promise<void> {
    if (!businessId || !payment) return;
    setErrorKey(null);
    setSavedKey(null);

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return setErrorKey('photo.permissionDenied');

    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    const asset = picked.canceled ? null : picked.assets[0];
    if (!asset) return;

    setBusy(true);
    try {
      const failed = await uploadProof(businessId, payment.id, {
        uri: asset.uri,
        fileName: asset.fileName ?? null,
        mimeType: asset.mimeType ?? null,
      });
      if (failed) return setErrorKey(failed);
      setSavedKey('payment.proof.uploaded');
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

  if (!payment) {
    return (
      <Screen>
        <Empty title={t('payment.error.notFound')} body={t('payment.empty.body')} />
        <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  const money = (value: number | string) => formatMoney(locale, Number(value), payment.currency);

  // A refund is its own row; what is left to refund is the payment minus them.
  const refunded = payment.adjustments
    .filter((adjustment) => adjustment.action === 'refund')
    .reduce((sum, adjustment) => sum + Number(adjustment.corrected_amount ?? 0), 0);
  const refundable = Math.max(Number(payment.amount) - refunded, 0);

  function confirmVoid(): void {
    if (reason.trim().length < 3) return setErrorKey('payment.reason.required');
    Alert.alert(t('payment.void.title'), t('payment.void.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('payment.void'),
        style: 'destructive',
        onPress: () =>
          void run(() => voidPayment(payment.id, reason.trim()), 'payment.void.done'),
      },
    ]);
  }

  return (
    <Screen>
      <Title
        title={t('payment.detail.title', { number: payment.payment_number })}
        subtitle={payment.booking?.booking_number ?? ''}
      />

      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}
      {savedKey ? <Banner tone="success">{t(savedKey)}</Banner> : null}
      {payment.status === 'voided' ? <Banner tone="error">{t('payment.error.voided')}</Banner> : null}
      {payment.duplicate_override || payment.overpayment_override ? (
        <Banner tone="info">{payment.override_reason ?? t('payment.override.reason')}</Banner>
      ) : null}

      <Card>
        <Row label={t('payment.number')} value={payment.payment_number} />
        <Row label={t('payment.amount')} value={money(payment.amount)} />
        <Row label={t('payment.method')} value={t(paymentMethodKey(payment.method))} />
        <Row label={t('payment.type')} value={t(paymentTypeKey(payment.payment_type))} />
        <Row label={t('payment.status')} value={t(paymentStatusKey(payment.status))} />
        <Row
          label={t('payment.date')}
          value={formatDateTime(locale, payment.paid_at, timezone)}
        />
        <Row label={t('payment.reference')} value={payment.reference || t('common.notSet')} />
        <Row label={t('payment.payer')} value={payment.payer_name || t('common.notSet')} />
        <Row label={t('payment.customer')} value={payment.customer?.full_name ?? ''} />
        <Row label={t('payment.property')} value={payment.property?.name ?? ''} />
        <Row label={t('payment.note')} value={payment.note || t('common.notSet')} />
      </Card>

      {payment.booking ? (
        <Button
          label={t('payment.booking')}
          variant="secondary"
          onPress={() => router.push(`/booking/${payment.booking_id}`)}
        />
      ) : null}

      <Text style={styles.section}>{t('payment.proof.title')}</Text>
      <Text style={styles.muted}>{t('payment.proof.hint')}</Text>
      <Button
        label={busy ? t('payment.proof.uploading') : t('payment.proof.add')}
        variant="secondary"
        loading={busy}
        onPress={() => void pickAndUpload()}
      />
      {payment.proofs.length === 0 ? (
        <Text style={styles.muted}>{t('payment.proof.empty')}</Text>
      ) : (
        payment.proofs.map((proof) => {
          const uri = urls[proof.storage_path];
          if (proof.mime_type === 'application/pdf') {
            return (
              <Button
                key={proof.id}
                label={`${t('payment.proof.pdf')} · ${t('payment.proof.view')}`}
                variant="secondary"
                disabled={!uri}
                onPress={() => uri && void Linking.openURL(uri)}
              />
            );
          }
          return (
            <View key={proof.id} style={styles.proof}>
              {uri ? (
                <Image source={{ uri }} style={styles.image} accessibilityIgnoresInvertColors />
              ) : (
                <Text style={styles.muted}>{t('payment.proof.error.load')}</Text>
              )}
            </View>
          );
        })
      )}

      {payment.adjustments.length > 0 ? (
        <>
          <Text style={styles.section}>{t('payment.adjustments.title')}</Text>
          <Card>
            {payment.adjustments.map((adjustment) => (
              <Row
                key={adjustment.id}
                label={t(`payment.adjustment.${adjustment.action}` as TranslationKey)}
                value={
                  adjustment.action === 'correct'
                    ? t('payment.adjustment.change', {
                        from: money(adjustment.original_amount),
                        to: money(adjustment.corrected_amount ?? 0),
                      })
                    : adjustment.action === 'refund'
                      ? money(adjustment.corrected_amount ?? 0)
                      : money(adjustment.original_amount)
                }
              />
            ))}
          </Card>
          {payment.adjustments.map((adjustment) => (
            <Text key={`${adjustment.id}-reason`} style={styles.muted}>
              {`${formatDateTime(locale, adjustment.created_at, timezone)} · ${adjustment.reason}`}
            </Text>
          ))}
        </>
      ) : null}

      {canVerifyPayment(business.role, payment) ? (
        <Button
          label={t('payment.verify')}
          variant="secondary"
          loading={busy}
          onPress={() =>
            Alert.alert(t('payment.verify'), t('payment.verify.confirm'), [
              { text: t('common.cancel'), style: 'cancel' },
              {
                text: t('payment.verify'),
                onPress: () => void run(() => verifyPayment(payment.id), 'payment.verify.done'),
              },
            ])
          }
        />
      ) : null}

      {canCorrectPayment(business.role, payment) ? (
        <Button
          label={t('payment.correct')}
          variant="secondary"
          onPress={() => {
            setAmount(Number(payment.amount).toFixed(2));
            setPanel(panel === 'correct' ? null : 'correct');
          }}
        />
      ) : null}

      {canRefundPayment(business.role, payment) && refundable > 0 ? (
        <Button
          label={t('payment.refund')}
          variant="secondary"
          onPress={() => {
            setAmount(refundable.toFixed(2));
            setPanel(panel === 'refund' ? null : 'refund');
          }}
        />
      ) : null}

      <Button
        label={t('receipt.issue')}
        variant="secondary"
        onPress={() => setPanel(panel === 'receipt' ? null : 'receipt')}
      />

      {canVoidPayment(business.role, payment) ? (
        <Button
          label={t('payment.void')}
          variant="ghost"
          onPress={() => setPanel(panel === 'void' ? null : 'void')}
        />
      ) : null}

      {panel === 'correct' ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>{t('payment.correct.title')}</Text>
          <Text style={styles.muted}>{t('payment.correct.body')}</Text>
          {payment.status === 'verified' ? (
            <Text style={styles.muted}>{t('payment.correct.reverify')}</Text>
          ) : null}
          <Field
            label={t('payment.amount')}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
          />
          <Field
            label={t('payment.reason')}
            hint={t('payment.reason.required')}
            value={reason}
            onChangeText={setReason}
            maxLength={300}
          />
          <Button
            label={t('payment.correct')}
            loading={busy}
            onPress={() => {
              const value = Number(amount.replace(',', '.'));
              if (!Number.isFinite(value) || value <= 0) return setErrorKey('validation.price');
              if (reason.trim().length < 3) return setErrorKey('payment.reason.required');
              void run(
                () => correctPayment(payment.id, value, reason.trim()),
                'payment.correct.done',
              );
            }}
          />
        </View>
      ) : null}

      {panel === 'refund' ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>{t('payment.refund.title')}</Text>
          <Field
            label={t('payment.refund.amount')}
            hint={t('payment.refund.max', { amount: money(refundable) })}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
          />
          <Field
            label={t('payment.reason')}
            hint={t('payment.reason.required')}
            value={reason}
            onChangeText={setReason}
            maxLength={300}
          />
          <Button
            label={t('payment.refund')}
            loading={busy}
            onPress={() => {
              const value = Number(amount.replace(',', '.'));
              if (!Number.isFinite(value) || value <= 0) return setErrorKey('validation.price');
              if (reason.trim().length < 3) return setErrorKey('payment.reason.required');
              void run(
                () => refundPayment(payment.id, value, reason.trim()),
                'payment.refund.done',
              );
            }}
          />
        </View>
      ) : null}

      {panel === 'void' ? (
        <View style={[styles.panel, styles.panelDanger]}>
          <Text style={styles.panelTitle}>{t('payment.void.title')}</Text>
          <Text style={styles.muted}>{t('payment.void.body')}</Text>
          <Field
            label={t('payment.reason')}
            hint={t('payment.reason.required')}
            value={reason}
            onChangeText={setReason}
            maxLength={300}
          />
          <Button label={t('payment.void')} variant="secondary" loading={busy} onPress={confirmVoid} />
        </View>
      ) : null}

      {panel === 'receipt' ? (
        <View style={styles.panel}>
          <ChoiceGroup
            label={t('receipt.language')}
            options={LOCALES}
            value={receiptLanguage}
            onChange={setReceiptLanguage}
            renderLabel={(value) => t(value === 'km' ? 'common.khmer' : 'common.english')}
          />
          <Button
            label={t('receipt.issue')}
            loading={busy}
            onPress={() =>
              void run(async () => {
                const result = await issueReceipt(
                  payment.booking_id,
                  payment.id,
                  receiptLanguage,
                );
                if (!result.errorKey && result.id) router.push(`/receipt/${result.id}`);
                return result;
              }, 'receipt.issued')
            }
          />
        </View>
      ) : null}

      <Text style={styles.audit}>
        {`${t('payment.recordedBy')} · ${formatDateTime(locale, payment.created_at, timezone)}`}
      </Text>
      {payment.verified_at ? (
        <Text style={styles.audit}>
          {`${t('payment.verifiedBy')} · ${formatDateTime(locale, payment.verified_at, timezone)}`}
        </Text>
      ) : (
        <Text style={styles.audit}>{t('payment.verify.pending')}</Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 16, fontWeight: '600', color: colors.text, paddingTop: 8 },
  muted: { fontSize: 13, lineHeight: 20, color: colors.muted },
  audit: { fontSize: 12, color: colors.muted, textAlign: 'center' },

  proof: { borderRadius: 6, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  image: { width: '100%', height: 260, backgroundColor: '#e2e8f0' },

  panel: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    gap: 10,
  },
  panelDanger: { backgroundColor: colors.dangerSoft, borderColor: '#fecaca' },
  panelTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
});
