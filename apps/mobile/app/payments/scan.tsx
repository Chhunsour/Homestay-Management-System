import { useCallback, useEffect, useReducer, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { Image, StyleSheet, Text, View } from 'react-native';
import {
  CURRENCIES,
  OCR_REVIEW_FIELDS,
  PAYMENT_METHODS,
  PROOF_MAX_BYTES,
  RECORDABLE_PAYMENT_TYPES,
  bookingPaymentStatus,
  bookingPaymentStatusKey,
  bytesToBase64,
  buildConfirmationPayload,
  can,
  depositRequired,
  editedFields,
  fieldErrors,
  formatMoney,
  initialOcrFlowState,
  isOverridable,
  isProofMimeType,
  lowConfidenceFields,
  ocrFlowReducer,
  ocrReviewFieldsSchema,
  paymentMethodKey,
  paymentTypeKey,
  priceBooking,
  round2,
  zonedTimeToUtc,
} from '@homestay/shared';
import type {
  BookingConflict,
  Currency,
  OcrBookingSelection,
  OcrCustomerSelection,
  OcrFlowState,
  OcrReviewFieldName,
  OcrWarning,
  PaymentMethod,
  PropertyWithDetails,
  TranslationKey,
} from '@homestay/shared';
import { Banner, Button, Card, Field, Row, Screen, Title, colors } from '@/components/ui';
import { ChoiceGroup } from '@/components/ChoiceGroup';
import { Loading } from '@/components/Loading';
import { useSession } from '@/lib/session';
import { createCustomer, listCustomers, type CustomerPage } from '@/lib/customers';
import {
  checkOcrAvailability,
  listBookableProperties,
  searchOcrBookings,
  type OcrAvailabilityResult,
  type OcrBookingCandidate,
} from '@/lib/bookings';
import {
  confirmOcrPayment,
  getProofPreviewUrl,
  issueReceipt,
  listRecentProofs,
  runOcr,
  type ConfirmOcrPaymentExtras,
  type ConfirmOcrPaymentResult,
  type PickedProof,
} from '@/lib/payments';
import type { RecentProof } from '@/lib/payments';

/**
 * The OCR flow: pick a screenshot, read it, correct it, match a guest, attach
 * it to a booking, confirm. `ocrFlowReducer` (from `@homestay/shared`) is the
 * same state machine the web app drives — this screen is I/O only.
 */
export default function OcrScanScreen() {
  const { t, locale, business } = useSession();
  const { proofId } = useLocalSearchParams<{ proofId?: string }>();
  const businessId = business?.business_id ?? '';
  const timezone = business?.timezone ?? 'Asia/Phnom_Penh';

  const [state, dispatch] = useReducer(
    ocrFlowReducer,
    initialOcrFlowState(businessId, proofId ?? null),
  );
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [recentProofs, setRecentProofs] = useState<RecentProof[]>([]);
  const [properties, setProperties] = useState<PropertyWithDetails[]>([]);
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  /** A freshly-picked screenshot never yet stored — attached once the payment exists. */
  const [pendingAsset, setPendingAsset] = useState<ImagePicker.ImagePickerAsset | null>(null);

  const loadRecentProofs = useCallback(async () => {
    if (!businessId) return;
    try {
      const [proofs, propertyList] = await Promise.all([
        listRecentProofs(businessId),
        listBookableProperties(businessId),
      ]);
      setRecentProofs(proofs);
      setProperties(propertyList);
    } catch {
      setRecentProofs([]);
    }
  }, [businessId]);

  useFocusEffect(
    useCallback(() => {
      void loadRecentProofs();
    }, [loadRecentProofs]),
  );

  const startOcrWithProof = useCallback(async (id: string) => {
    dispatch({ type: 'START_OCR', proofId: id });
    const [result, url] = await Promise.all([runOcr({ proofId: id }), getProofPreviewUrl(id)]);
    setPreviewUri(url);
    if (result.errorKey || !result.extraction) {
      dispatch({ type: 'OCR_FAILED', errorKey: result.errorKey ?? 'error.generic' });
      return;
    }
    dispatch({
      type: 'OCR_SUCCEEDED',
      extraction: result.extraction,
      duplicates: result.duplicates,
      possibleDuplicate: result.possibleDuplicate,
      proofId: id,
    });
  }, []);

  // Arriving from "run OCR on this proof" (payment/[id].tsx): skip the source step.
  useEffect(() => {
    if (proofId) void startOcrWithProof(proofId);
  }, [proofId, startOcrWithProof]);

  async function startOcrWithAsset(asset: ImagePicker.ImagePickerAsset) {
    const mimeType = asset.mimeType ?? 'image/jpeg';
    if (!isProofMimeType(mimeType)) {
      dispatch({ type: 'OCR_FAILED', errorKey: 'ocr.source.error.type' });
      return;
    }
    setPreviewUri(asset.uri);
    setPendingAsset(asset);
    dispatch({ type: 'START_OCR' });
    try {
      const bytes = await new File(asset.uri).bytes();
      if (bytes.byteLength > PROOF_MAX_BYTES) {
        dispatch({ type: 'OCR_FAILED', errorKey: 'ocr.source.error.size' });
        return;
      }
      const result = await runOcr({ businessId, imageBase64: bytesToBase64(bytes), mimeType });
      if (result.errorKey || !result.extraction) {
        dispatch({ type: 'OCR_FAILED', errorKey: result.errorKey ?? 'error.generic' });
        return;
      }
      dispatch({
        type: 'OCR_SUCCEEDED',
        extraction: result.extraction,
        duplicates: result.duplicates,
        possibleDuplicate: result.possibleDuplicate,
      });
    } catch {
      dispatch({ type: 'OCR_FAILED', errorKey: 'error.network' });
    }
  }

  async function pickFromGallery() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted)
      return dispatch({ type: 'OCR_FAILED', errorKey: 'photo.permissionDenied' });
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });
    const asset = picked.canceled ? null : picked.assets[0];
    if (asset) void startOcrWithAsset(asset);
  }

  async function pickFromCamera() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted)
      return dispatch({ type: 'OCR_FAILED', errorKey: 'photo.permissionDenied' });
    const picked = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 });
    const asset = picked.canceled ? null : picked.assets[0];
    if (asset) void startOcrWithAsset(asset);
  }

  function retry() {
    dispatch({ type: 'RETRY' });
    if (state.proofId) void startOcrWithProof(state.proofId);
    else dispatch({ type: 'OCR_FAILED', errorKey: 'error.generic' });
  }

  function continueReview() {
    const parsed = ocrReviewFieldsSchema.safeParse(state.values);
    if (!parsed.success) {
      setReviewErrors(fieldErrors(parsed.error));
      return;
    }
    setReviewErrors({});
    dispatch({ type: 'CONTINUE_REVIEW' });
  }

  if (!business) return <Loading />;

  const money = (amount: number, currency: Currency) => formatMoney(locale, amount, currency);

  function startOver(): void {
    setPreviewUri(null);
    setPendingAsset(null);
    dispatch({ type: 'RESTART' });
  }

  async function confirmPayment(extra: ConfirmOcrPaymentExtras): Promise<ConfirmOcrPaymentResult> {
    const payload = buildConfirmationPayload(state);
    if (!payload) throw new Error('missing customer or booking selection');
    const proofUpload: PickedProof | null =
      !state.proofId && pendingAsset
        ? {
            uri: pendingAsset.uri,
            fileName: pendingAsset.fileName ?? null,
            mimeType: pendingAsset.mimeType ?? 'image/jpeg',
          }
        : null;
    return confirmOcrPayment(businessId, timezone, payload, extra, proofUpload);
  }

  return (
    <Screen>
      <Title title={t('ocr.title')} subtitle={t('ocr.subtitle')} />

      {state.step === 'source' ? (
        <SourceStep
          errorKey={state.errorKey}
          recentProofs={recentProofs}
          onGallery={() => void pickFromGallery()}
          onCamera={() => void pickFromCamera()}
          onProof={(proof) => void startOcrWithProof(proof.id)}
          onManual={() => dispatch({ type: 'SKIP_TO_MANUAL' })}
          onCancel={() => router.back()}
        />
      ) : null}

      {state.step === 'processing' ? (
        <View style={styles.processing}>
          <Loading />
          <Text style={styles.muted}>{t('ocr.processing.body')}</Text>
        </View>
      ) : null}

      {state.step === 'review' ? (
        <ReviewStep
          state={state}
          previewUri={previewUri}
          errors={reviewErrors}
          money={money}
          onChange={(field, value) => dispatch({ type: 'FIELD_CHANGED', field, value })}
          onRetry={retry}
          onManual={() => dispatch({ type: 'SKIP_TO_MANUAL' })}
          onContinue={continueReview}
          onCancel={() => dispatch({ type: 'RESTART' })}
        />
      ) : null}

      {state.step === 'customer' ? (
        <CustomerStep
          businessId={businessId}
          selection={state.customer}
          onSelect={(customer) => dispatch({ type: 'SELECT_CUSTOMER', customer })}
          onContinue={() => dispatch({ type: 'CONTINUE_CUSTOMER' })}
          onBack={() => dispatch({ type: 'BACK' })}
        />
      ) : null}

      {state.step === 'booking' ? (
        <BookingStep
          businessId={businessId}
          timezone={timezone}
          properties={properties}
          amount={Number(state.values.amount) || 0}
          currency={(state.values.currency || 'USD') as Currency}
          selection={state.booking}
          canOverridePrice={can(business.role, 'bookings.price.override')}
          canOverrideConflict={can(business.role, 'bookings.conflict.override')}
          onSelect={(bookingSelection) => dispatch({ type: 'SELECT_BOOKING', booking: bookingSelection })}
          onContinue={() => dispatch({ type: 'CONTINUE_BOOKING' })}
          onBack={() => dispatch({ type: 'BACK' })}
        />
      ) : null}

      {state.step === 'confirmation' ? (
        <ConfirmationStep
          state={state}
          money={money}
          canOverridePayment={can(business.role, 'payments.override')}
          onConfirm={confirmPayment}
          onBack={() => dispatch({ type: 'BACK' })}
          onStartOver={startOver}
        />
      ) : null}
    </Screen>
  );
}

// --- step 1: source ------------------------------------------------------------

function SourceStep({
  errorKey,
  recentProofs,
  onGallery,
  onCamera,
  onProof,
  onManual,
  onCancel,
}: {
  errorKey: string | null;
  recentProofs: RecentProof[];
  onGallery: () => void;
  onCamera: () => void;
  onProof: (proof: RecentProof) => void;
  onManual: () => void;
  onCancel: () => void;
}) {
  const { t } = useSession();

  return (
    <View style={styles.stack}>
      <Text style={styles.section}>{t('ocr.step.source.title')}</Text>
      <Text style={styles.muted}>{t('ocr.step.source.subtitle')}</Text>

      {errorKey ? <Banner tone="error">{t(errorKey as TranslationKey)}</Banner> : null}

      <Button label={t('ocr.source.gallery')} onPress={onGallery} />
      <Button label={t('ocr.source.camera')} variant="secondary" onPress={onCamera} />

      {recentProofs.length > 0 ? (
        <>
          <Text style={styles.section}>{t('ocr.source.existingProof')}</Text>
          <Card>
            {recentProofs.map((proof) => (
              <Row
                key={proof.id}
                label={proof.payment?.payment_number ?? (proof.file_name || proof.id)}
                value={
                  <Button
                    label={t('ocr.customer.select')}
                    variant="secondary"
                    onPress={() => onProof(proof)}
                  />
                }
              />
            ))}
          </Card>
        </>
      ) : (
        <Text style={styles.muted}>{t('ocr.source.existingProof.empty')}</Text>
      )}

      <Button label={t('ocr.manualEntry')} variant="ghost" onPress={onManual} />
      <Text style={styles.muted}>{t('ocr.manualEntry.body')}</Text>
      <Button label={t('common.cancel')} variant="ghost" onPress={onCancel} />
    </View>
  );
}

// --- step 3: review ---------------------------------------------------------------

const WARNING_KEYS: Record<OcrWarning, TranslationKey> = {
  amount_missing: 'ocr.warning.amount_missing',
  currency_ambiguous: 'ocr.warning.currency_ambiguous',
  reference_missing: 'ocr.warning.reference_missing',
  date_missing: 'ocr.warning.date_missing',
  time_missing: 'ocr.warning.time_missing',
  payer_name_missing: 'ocr.warning.payer_name_missing',
  low_overall_confidence: 'ocr.warning.low_overall_confidence',
  provider_error: 'ocr.warning.provider_error',
};

const FIELD_LABEL_KEYS: Record<OcrReviewFieldName, TranslationKey> = {
  payerName: 'payment.payer',
  receiverName: 'ocr.field.receiverName',
  amount: 'payment.amount',
  currency: 'payment.currency',
  reference: 'payment.reference',
  paymentDate: 'payment.date',
  paymentTime: 'ocr.field.paymentTime',
  method: 'payment.method',
};

function ReviewStep({
  state,
  previewUri,
  errors,
  money,
  onChange,
  onRetry,
  onManual,
  onContinue,
  onCancel,
}: {
  state: ReturnType<typeof initialOcrFlowState>;
  previewUri: string | null;
  errors: Record<string, string>;
  money: (amount: number, currency: Currency) => string;
  onChange: (field: OcrReviewFieldName, value: string) => void;
  onRetry: () => void;
  onManual: () => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const { t } = useSession();
  const { extraction, values } = state;
  const edited = new Set(editedFields(state.original, values));
  const lowConfidence = new Set(extraction ? lowConfidenceFields(extraction) : []);

  const hint = (field: OcrReviewFieldName): string | undefined => {
    if (lowConfidence.has(field)) return t('ocr.confidence.low');
    if (edited.has(field)) return t('ocr.field.edited');
    return undefined;
  };

  return (
    <View style={styles.stack}>
      <Text style={styles.section}>{t('ocr.step.review.title')}</Text>
      <Text style={styles.muted}>{t('ocr.step.review.subtitle')}</Text>

      {previewUri ? (
        <Image source={{ uri: previewUri }} style={styles.image} accessibilityIgnoresInvertColors />
      ) : (
        <Text style={styles.muted}>{t('ocr.manualEntry.notice')}</Text>
      )}

      {extraction ? (
        <Text style={styles.muted}>
          {t('ocr.confidence.overall', { percent: Math.round(extraction.overallConfidence * 100) })}
        </Text>
      ) : null}

      {extraction?.warnings.length
        ? extraction.warnings.map((warning) => (
            <Banner key={warning} tone="info">
              {t(WARNING_KEYS[warning])}
            </Banner>
          ))
        : null}

      {state.possibleDuplicate ? (
        <View style={styles.warning}>
          <Text style={styles.warningTitle}>{t('payment.duplicate.title')}</Text>
          <Text style={styles.warningBody}>{t('ocr.duplicate.body')}</Text>
          {state.duplicates.map((duplicate) => (
            <Text key={duplicate.id} style={styles.warningBody}>
              {t('payment.duplicate.match', {
                number: duplicate.payment_number,
                amount: money(Number(duplicate.amount), duplicate.currency),
                date: duplicate.paid_at,
              })}
            </Text>
          ))}
        </View>
      ) : null}

      <Field
        label={t(FIELD_LABEL_KEYS.payerName)}
        hint={hint('payerName')}
        error={errors.payerName ? t(errors.payerName as TranslationKey) : undefined}
        value={values.payerName}
        onChangeText={(value) => onChange('payerName', value)}
      />
      <Field
        label={t(FIELD_LABEL_KEYS.receiverName)}
        hint={hint('receiverName')}
        error={errors.receiverName ? t(errors.receiverName as TranslationKey) : undefined}
        value={values.receiverName}
        onChangeText={(value) => onChange('receiverName', value)}
      />
      <Field
        label={t(FIELD_LABEL_KEYS.amount)}
        hint={hint('amount')}
        error={errors.amount ? t(errors.amount as TranslationKey) : undefined}
        value={values.amount}
        onChangeText={(value) => onChange('amount', value)}
        keyboardType="decimal-pad"
      />
      <ChoiceGroup<'' | Currency>
        label={t(FIELD_LABEL_KEYS.currency)}
        options={['', ...CURRENCIES]}
        value={values.currency}
        onChange={(value) => onChange('currency', value)}
        renderLabel={(value) => (value ? value : t('common.notSet'))}
        error={errors.currency ? t(errors.currency as TranslationKey) : undefined}
      />
      <Field
        label={t(FIELD_LABEL_KEYS.reference)}
        hint={hint('reference')}
        error={errors.reference ? t(errors.reference as TranslationKey) : undefined}
        value={values.reference}
        onChangeText={(value) => onChange('reference', value)}
        autoCapitalize="characters"
      />
      <Field
        label={t(FIELD_LABEL_KEYS.paymentDate)}
        hint={hint('paymentDate') ?? 'YYYY-MM-DD'}
        error={errors.paymentDate ? t(errors.paymentDate as TranslationKey) : undefined}
        value={values.paymentDate}
        onChangeText={(value) => onChange('paymentDate', value)}
        placeholder="2026-08-21"
      />
      <Field
        label={t(FIELD_LABEL_KEYS.paymentTime)}
        hint={hint('paymentTime') ?? 'HH:MM'}
        error={errors.paymentTime ? t(errors.paymentTime as TranslationKey) : undefined}
        value={values.paymentTime}
        onChangeText={(value) => onChange('paymentTime', value)}
        placeholder="14:32"
      />
      <ChoiceGroup<'' | PaymentMethod>
        label={t(FIELD_LABEL_KEYS.method)}
        options={['', ...PAYMENT_METHODS]}
        value={values.method}
        onChange={(value) => onChange('method', value)}
        renderLabel={(value) => (value ? t(paymentMethodKey(value)) : t('common.notSet'))}
        error={errors.method ? t(errors.method as TranslationKey) : undefined}
      />
      {values.methodLabel ? (
        <Text style={styles.muted}>
          {t('ocr.field.methodLabel')}: {values.methodLabel}
        </Text>
      ) : null}

      <Button label={t('common.continue')} onPress={onContinue} />
      <Button label={t('ocr.retry')} variant="secondary" onPress={onRetry} />
      {!state.manualEntry ? (
        <Button label={t('ocr.manualEntry')} variant="ghost" onPress={onManual} />
      ) : null}
      <Button label={t('common.cancel')} variant="ghost" onPress={onCancel} />
    </View>
  );
}

// --- step 4: customer --------------------------------------------------------

function CustomerStep({
  businessId,
  selection,
  onSelect,
  onContinue,
  onBack,
}: {
  businessId: string;
  selection: OcrCustomerSelection | null;
  onSelect: (customer: OcrCustomerSelection) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { t } = useSession();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerPage['customers']>([]);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'existing' || !query.trim()) {
      setResults([]);
      return;
    }
    const timeout = setTimeout(() => {
      void listCustomers(businessId, { search: query, filter: 'active' }).then((page) =>
        setResults(page.customers.slice(0, 8)),
      );
    }, 300);
    return () => clearTimeout(timeout);
  }, [businessId, mode, query]);

  async function confirmNewCustomer(): Promise<void> {
    if (!newName.trim() || !newPhone.trim()) {
      setErrorKey('validation.required');
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const result = await createCustomer(businessId, {
        fullName: newName.trim(),
        phone: newPhone.trim(),
        phoneSecondary: null,
        email: null,
        facebookName: null,
        facebookUrl: null,
        telegramUsername: null,
        preferredLanguage: 'en',
        address: null,
        note: null,
      });
      if (result.errorKey || !result.id) {
        setErrorKey(result.errorKey ?? 'error.generic');
        return;
      }
      onSelect({ type: 'existing', customerId: result.id, fullName: newName.trim() });
      onContinue();
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.stack}>
      <Text style={styles.section}>{t('ocr.step.customer.title')}</Text>
      <Text style={styles.muted}>{t('ocr.step.customer.subtitle')}</Text>

      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}

      <ChoiceGroup
        label={t('payment.customer')}
        options={['existing', 'new'] as const}
        value={mode}
        onChange={setMode}
        renderLabel={(value) =>
          value === 'existing' ? t('booking.customer.existing') : t('booking.customer.new')
        }
      />

      {mode === 'existing' ? (
        <>
          <Field
            label={t('ocr.customer.search.placeholder')}
            value={query}
            onChangeText={setQuery}
          />
          {query.trim() && results.length === 0 ? (
            <Text style={styles.muted}>{t('ocr.customer.search.empty')}</Text>
          ) : null}
          <Card>
            {results.map((customer) => {
              const isSelected =
                selection?.type === 'existing' && selection.customerId === customer.id;
              return (
                <Row
                  key={customer.id}
                  label={`${customer.full_name} · ${customer.phone}`}
                  value={
                    <Button
                      label={isSelected ? t('ocr.customer.selected') : t('ocr.customer.select')}
                      variant={isSelected ? 'primary' : 'secondary'}
                      onPress={() =>
                        onSelect({
                          type: 'existing',
                          customerId: customer.id,
                          fullName: customer.full_name,
                        })
                      }
                    />
                  }
                />
              );
            })}
          </Card>
        </>
      ) : (
        <>
          <Field label={t('booking.customer.name')} value={newName} onChangeText={setNewName} />
          <Field label={t('booking.customer.phone')} value={newPhone} onChangeText={setNewPhone} />
        </>
      )}

      {mode === 'new' ? (
        <Button
          label={t('common.continue')}
          loading={busy}
          onPress={() => void confirmNewCustomer()}
        />
      ) : (
        <Button label={t('common.continue')} disabled={!selection} onPress={onContinue} />
      )}
      <Button label={t('common.back')} variant="ghost" onPress={onBack} />
    </View>
  );
}

// --- step 4b: booking ---------------------------------------------------------

/** What a booking owes, before and after this reviewed amount lands on it. */
interface PaymentOutcome {
  bookingTotal: number;
  depositRequired: number;
  previouslyPaid: number;
  newTotal: number;
  remaining: number;
  status: ReturnType<typeof bookingPaymentStatus>;
  overpaid: boolean;
}

function bookingTotalOf(selection: OcrBookingSelection): number {
  return selection.type === 'existing' ? selection.bookingTotal : (selection.finalPrice ?? selection.calculatedPrice);
}

function computeOutcome(selection: OcrBookingSelection, amount: number): PaymentOutcome {
  const bookingTotal = bookingTotalOf(selection);
  const previouslyPaid = selection.type === 'existing' ? selection.netPaid : 0;
  const deposit = depositRequired(bookingTotal);
  const newTotal = round2(previouslyPaid + amount);
  const remaining = round2(Math.max(bookingTotal - newTotal, 0));
  const status = bookingPaymentStatus({
    bookingTotal,
    totals: { totalPaid: newTotal, refundTotal: 0, netPaid: newTotal },
  });
  return {
    bookingTotal,
    depositRequired: deposit,
    previouslyPaid,
    newTotal,
    remaining,
    status,
    overpaid: newTotal > bookingTotal,
  };
}

function depositMessageKey(outcome: PaymentOutcome): TranslationKey | null {
  if (outcome.overpaid) return null;
  if (outcome.newTotal === outcome.bookingTotal) return 'ocr.deposit.full';
  if (outcome.newTotal === outcome.depositRequired) return 'ocr.deposit.exact';
  if (outcome.newTotal > outcome.depositRequired) return 'ocr.deposit.advance';
  return 'ocr.deposit.incomplete';
}

function OutcomeSummary({
  outcome,
  currency,
  money,
}: {
  outcome: PaymentOutcome;
  currency: Currency;
  money: (amount: number, currency: Currency) => string;
}) {
  const { t } = useSession();
  const messageKey = depositMessageKey(outcome);
  return (
    <>
      <Card>
        <Row label={t('ocr.booking.summary.total')} value={money(outcome.bookingTotal, currency)} />
        <Row label={t('ocr.booking.summary.deposit')} value={money(outcome.depositRequired, currency)} />
        <Row label={t('ocr.booking.summary.paid')} value={money(outcome.previouslyPaid, currency)} />
        <Row label={t('ocr.booking.summary.newTotal')} value={money(outcome.newTotal, currency)} />
        <Row label={t('ocr.booking.summary.remaining')} value={money(outcome.remaining, currency)} />
        <Row label={t('ocr.booking.summary.statusAfter')} value={t(bookingPaymentStatusKey(outcome.status))} />
      </Card>
      {outcome.overpaid ? (
        <Banner tone="error">
          {t('payment.overpayment.warning', {
            amount: money(outcome.newTotal - outcome.bookingTotal, currency),
          })}
        </Banner>
      ) : messageKey ? (
        <Banner tone="info">{t(messageKey)}</Banner>
      ) : null}
    </>
  );
}

function BookingStep({
  businessId,
  timezone,
  properties,
  amount,
  currency,
  selection,
  canOverridePrice,
  canOverrideConflict,
  onSelect,
  onContinue,
  onBack,
}: {
  businessId: string;
  timezone: string;
  properties: PropertyWithDetails[];
  amount: number;
  currency: Currency;
  selection: OcrBookingSelection | null;
  canOverridePrice: boolean;
  canOverrideConflict: boolean;
  onSelect: (selection: OcrBookingSelection | null) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { t, locale } = useSession();
  const [mode, setMode] = useState<'existing' | 'new'>(selection?.type ?? 'existing');
  const money = (value: number, valueCurrency: Currency) => formatMoney(locale, value, valueCurrency);

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<OcrBookingCandidate[]>([]);

  useEffect(() => {
    if (mode !== 'existing') return;
    const timeout = setTimeout(() => {
      void searchOcrBookings(businessId, { search: search.trim() || undefined }).then(setResults);
    }, 300);
    return () => clearTimeout(timeout);
  }, [businessId, mode, search]);

  function pickExisting(candidate: OcrBookingCandidate): void {
    onSelect({
      type: 'existing',
      bookingId: candidate.id,
      bookingNumber: candidate.booking_number,
      propertyId: candidate.property_id,
      propertyName: candidate.property_name,
      checkInAt: candidate.check_in_at,
      checkOutAt: candidate.check_out_at,
      currency: candidate.currency,
      bookingTotal: candidate.booking_total,
      depositRequired: candidate.deposit_required,
      netPaid: candidate.net_paid,
      balance: candidate.balance,
      paymentStatus: candidate.payment_status,
    });
  }

  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? '');
  const [checkInDate, setCheckInDate] = useState('');
  const [checkInTime, setCheckInTime] = useState('');
  const [checkOutDate, setCheckOutDate] = useState('');
  const [checkOutTime, setCheckOutTime] = useState('');
  const [overridePrice, setOverridePrice] = useState(false);
  const [finalPriceInput, setFinalPriceInput] = useState('');
  const [priceReason, setPriceReason] = useState('');
  const [note, setNote] = useState('');
  const [conflictReason, setConflictReason] = useState('');
  const [availability, setAvailability] = useState<OcrAvailabilityResult | null>(null);

  const checkInAt = checkInDate && checkInTime ? `${checkInDate}T${checkInTime}` : '';
  const checkOutAt = checkOutDate && checkOutTime ? `${checkOutDate}T${checkOutTime}` : '';
  const validRange = Boolean(checkInAt && checkOutAt && checkOutAt > checkInAt);
  const property = properties.find((row) => row.id === propertyId);
  const preview =
    property?.pricing && validRange
      ? priceBooking(
          property.pricing,
          zonedTimeToUtc(checkInAt, timezone),
          zonedTimeToUtc(checkOutAt, timezone),
          timezone,
        )
      : null;

  useEffect(() => {
    if (mode !== 'new' || !propertyId || !validRange) {
      setAvailability(null);
      return;
    }
    const timeout = setTimeout(() => {
      void checkOcrAvailability(businessId, timezone, { propertyId, checkInAt, checkOutAt }).then(
        setAvailability,
      );
    }, 400);
    return () => clearTimeout(timeout);
  }, [businessId, timezone, mode, propertyId, checkInAt, checkOutAt, validRange]);

  const overridable = availability ? isOverridable(availability.conflicts) && canOverrideConflict : false;
  const blocked = Boolean(availability && !availability.available);
  const priceOverridden = overridePrice && finalPriceInput.trim() !== '';

  useEffect(() => {
    if (mode !== 'new') return;
    if (!property || !preview) return void onSelect(null);
    if (priceOverridden && priceReason.trim().length < 3) return void onSelect(null);
    if (blocked && !(overridable && conflictReason.trim().length >= 3)) {
      return void onSelect(null);
    }
    onSelect({
      type: 'new',
      propertyId,
      propertyName: property.name,
      checkInAt,
      checkOutAt,
      currency: preview.currency,
      calculatedPrice: preview.total,
      finalPrice: priceOverridden ? Number(finalPriceInput) : null,
      priceOverrideReason: priceOverridden ? priceReason : '',
      conflictOverride: blocked && conflictReason.trim().length > 0,
      conflictOverrideReason: conflictReason,
      note,
    });
  }, [
    mode,
    property,
    preview,
    propertyId,
    checkInAt,
    checkOutAt,
    priceOverridden,
    finalPriceInput,
    priceReason,
    blocked,
    overridable,
    conflictReason,
    note,
    onSelect,
  ]);

  const outcome = selection ? computeOutcome(selection, amount) : null;
  const mismatch = selection && currency && selection.currency !== currency;

  return (
    <View style={styles.stack}>
      <Text style={styles.section}>{t('ocr.step.booking.title')}</Text>
      <Text style={styles.muted}>{t('ocr.step.booking.subtitle')}</Text>

      <ChoiceGroup
        label={t('payment.customer')}
        options={['existing', 'new'] as const}
        value={mode}
        onChange={(next) => {
          setMode(next);
          onSelect(null);
        }}
        renderLabel={(value) => (value === 'existing' ? t('ocr.booking.mode.existing') : t('ocr.booking.mode.new'))}
      />

      {mode === 'existing' ? (
        <>
          <Field label={t('ocr.booking.search.placeholder')} value={search} onChangeText={setSearch} />
          {results.length === 0 ? (
            <Text style={styles.muted}>{t('ocr.booking.search.empty')}</Text>
          ) : (
            <Card>
              {results.map((candidate) => {
                const isSelected = selection?.type === 'existing' && selection.bookingId === candidate.id;
                return (
                  <Row
                    key={candidate.id}
                    label={`${candidate.booking_number} · ${candidate.property_name}`}
                    value={
                      <Button
                        label={isSelected ? t('ocr.booking.selected') : t('ocr.booking.select')}
                        variant={isSelected ? 'primary' : 'secondary'}
                        onPress={() => pickExisting(candidate)}
                      />
                    }
                  />
                );
              })}
            </Card>
          )}
        </>
      ) : (
        <>
          <ChoiceGroup
            label={t('booking.property')}
            options={properties.map((row) => row.id)}
            value={propertyId}
            onChange={setPropertyId}
            renderLabel={(id) => properties.find((row) => row.id === id)?.name ?? ''}
          />
          <Field
            label={`${t('booking.checkIn')} — ${t('booking.field.date')}`}
            value={checkInDate}
            onChangeText={setCheckInDate}
            placeholder="2026-08-10"
            maxLength={10}
          />
          <Field
            label={`${t('booking.checkIn')} — ${t('booking.field.time')}`}
            value={checkInTime}
            onChangeText={setCheckInTime}
            placeholder="14:00"
            maxLength={5}
          />
          <Field
            label={`${t('booking.checkOut')} — ${t('booking.field.date')}`}
            value={checkOutDate}
            onChangeText={setCheckOutDate}
            placeholder="2026-08-12"
            maxLength={10}
          />
          <Field
            label={`${t('booking.checkOut')} — ${t('booking.field.time')}`}
            value={checkOutTime}
            onChangeText={setCheckOutTime}
            placeholder="12:00"
            maxLength={5}
          />

          {preview ? (
            <Card>
              <Row
                label={t('booking.price.calculated')}
                value={money(preview.total, preview.currency)}
              />
              <Row
                label={t('booking.days', { count: String(preview.days.length) })}
                value={t('booking.price.breakdown', {
                  weekdayCount: String(preview.weekdayCount),
                  weekendCount: String(preview.weekendCount),
                })}
              />
            </Card>
          ) : null}

          {availability && validRange ? (
            availability.available ? (
              <Banner tone="info">{t('booking.conflict.free')}</Banner>
            ) : (
              <View style={styles.warning}>
                <Text style={styles.warningTitle}>{t('booking.conflict.title')}</Text>
                {availability.conflicts.map((conflict: BookingConflict) => (
                  <Text key={conflict.id} style={styles.warningBody}>
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
                  <Text style={styles.warningTitle}>
                    {isOverridable(availability.conflicts)
                      ? t('booking.conflict.forbidden')
                      : t('booking.error.propertyUnavailable')}
                  </Text>
                )}
              </View>
            )
          ) : null}

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
                    value={finalPriceInput}
                    onChangeText={setFinalPriceInput}
                    keyboardType="decimal-pad"
                  />
                  <Field
                    label={t('booking.price.override.reason')}
                    value={priceReason}
                    onChangeText={setPriceReason}
                    maxLength={300}
                  />
                </>
              ) : null}
            </>
          ) : null}

          <Field label={t('booking.note')} value={note} onChangeText={setNote} multiline numberOfLines={2} maxLength={2000} />
        </>
      )}

      {selection && outcome ? (
        <>
          {mismatch ? (
            <Banner tone="info">
              {t('ocr.currency.mismatch', { from: currency, to: selection.currency })}
            </Banner>
          ) : null}
          <OutcomeSummary outcome={outcome} currency={selection.currency} money={money} />
        </>
      ) : null}

      <Button label={t('common.continue')} disabled={!selection} onPress={onContinue} />
      <Button label={t('common.back')} variant="ghost" onPress={onBack} />
    </View>
  );
}

// --- step 5: confirmation -----------------------------------------------------

/** A sensible starting payment type — the reviewer can still change it. */
function defaultPaymentType(outcome: PaymentOutcome): (typeof RECORDABLE_PAYMENT_TYPES)[number] {
  if (outcome.newTotal >= outcome.bookingTotal) return 'full';
  if (outcome.previouslyPaid > 0) return 'balance';
  return 'deposit';
}

function ConfirmationStep({
  state,
  money,
  canOverridePayment,
  onConfirm,
  onBack,
  onStartOver,
}: {
  state: OcrFlowState;
  money: (amount: number, currency: Currency) => string;
  canOverridePayment: boolean;
  onConfirm: (extra: ConfirmOcrPaymentExtras) => Promise<ConfirmOcrPaymentResult>;
  onBack: () => void;
  onStartOver: () => void;
}) {
  const { t } = useSession();
  const payload = buildConfirmationPayload(state);
  const outcome = payload ? computeOutcome(payload.booking, Number(payload.values.amount) || 0) : null;

  const [paymentType, setPaymentType] = useState<(typeof RECORDABLE_PAYMENT_TYPES)[number]>('deposit');
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [result, setResult] = useState<ConfirmOcrPaymentResult | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [issuingReceipt, setIssuingReceipt] = useState(false);

  useEffect(() => {
    if (outcome) setPaymentType(defaultPaymentType(outcome));
  }, [outcome?.newTotal, outcome?.bookingTotal]);

  if (!payload || !outcome) return null;
  const { values } = payload;
  const currency = payload.booking.currency;
  const showDuplicateWarning = payload.possibleDuplicate;
  const showOverpaymentWarning = outcome.overpaid;
  // Mirrors BookingForm's own convention: typing a reason is the consent, there is no separate checkbox.
  const overrideGiven = overrideReason.trim().length >= 3;
  const duplicateOverride = showDuplicateWarning && canOverridePayment && overrideGiven;
  const overpaymentOverride = showOverpaymentWarning && canOverridePayment && overrideGiven;

  async function submit(): Promise<void> {
    setBusy(true);
    setErrorKey(null);
    try {
      const outcome_ = await onConfirm({
        paymentType,
        duplicateOverride,
        overpaymentOverride,
        overrideReason,
      });
      if (outcome_.errorKey) {
        setErrorKey(outcome_.errorKey);
        return;
      }
      setResult(outcome_);
    } finally {
      setBusy(false);
    }
  }

  async function generateReceipt(): Promise<void> {
    if (!result?.bookingId) return;
    setIssuingReceipt(true);
    try {
      const outcome_ = await issueReceipt(result.bookingId, result.paymentId, 'en');
      if (outcome_.id) setReceiptId(outcome_.id);
    } finally {
      setIssuingReceipt(false);
    }
  }

  if (result?.bookingId) {
    return (
      <View style={styles.stack}>
        <Banner tone="info">{t('ocr.confirmation.success')}</Banner>
        <Card>
          <Row label={t('booking.number')} value={result.bookingNumber ?? ''} />
          <Row label={t('payment.amount')} value={money(Number(values.amount), currency)} />
          <Row label={t('ocr.booking.summary.remaining')} value={money(outcome.remaining, currency)} />
        </Card>
        <Button
          label={t('booking.detail.title', { number: result.bookingNumber ?? '' })}
          onPress={() => router.replace(`/booking/${result.bookingId}`)}
        />
        {result.paymentId ? (
          <Button
            label={t('payment.detail.title', { number: result.paymentNumber ?? '' })}
            variant="secondary"
            onPress={() => router.push(`/payment/${result.paymentId}`)}
          />
        ) : null}
        {receiptId ? (
          <Button
            label={t('receipt.title')}
            variant="secondary"
            onPress={() => router.push(`/receipt/${receiptId}`)}
          />
        ) : (
          <Button
            label={t('receipt.issue')}
            variant="secondary"
            loading={issuingReceipt}
            onPress={() => void generateReceipt()}
          />
        )}
        <Button label={t('ocr.confirmation.startOver')} variant="ghost" onPress={onStartOver} />
      </View>
    );
  }

  return (
    <View style={styles.stack}>
      <Text style={styles.section}>{t('ocr.step.confirmation.title')}</Text>
      <Text style={styles.muted}>{t('ocr.step.confirmation.subtitle')}</Text>

      <Banner tone="info">{t('ocr.confirmation.notice')}</Banner>
      {state.manualEntry ? <Banner tone="info">{t('ocr.confirmation.manualEntry.badge')}</Banner> : null}
      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}

      <Card>
        {OCR_REVIEW_FIELDS.map((field) => (
          <Row
            key={field}
            label={t(FIELD_LABEL_KEYS[field])}
            value={
              field === 'amount' && values.amount
                ? money(Number(values.amount), currency)
                : field === 'method' && values.method
                  ? t(paymentMethodKey(values.method as PaymentMethod))
                  : (values[field] as string) || t('common.notSet')
            }
          />
        ))}
        <Row
          label={t('payment.customer')}
          value={
            payload.customer.type === 'existing'
              ? t('ocr.confirmation.customer.existing', { name: payload.customer.fullName })
              : t('ocr.confirmation.customer.new', { name: payload.customer.fullName })
          }
        />
        <Row
          label={t('booking.title')}
          value={
            payload.booking.type === 'existing'
              ? t('ocr.confirmation.booking.existing', { number: payload.booking.bookingNumber })
              : t('ocr.confirmation.booking.new', { property: payload.booking.propertyName })
          }
        />
      </Card>

      <OutcomeSummary outcome={outcome} currency={currency} money={money} />

      <ChoiceGroup
        label={t('payment.type' as TranslationKey)}
        options={RECORDABLE_PAYMENT_TYPES}
        value={paymentType}
        onChange={setPaymentType}
        renderLabel={(type) => t(paymentTypeKey(type))}
      />

      {showDuplicateWarning ? (
        <View style={styles.warning}>
          <Text style={styles.warningTitle}>{t('payment.duplicate.title')}</Text>
          <Text style={styles.warningBody}>{t('ocr.duplicate.body')}</Text>
          {payload.duplicates.map((duplicate) => (
            <Text key={duplicate.id} style={styles.warningBody}>
              {t('payment.duplicate.match', {
                number: duplicate.payment_number,
                amount: money(Number(duplicate.amount), duplicate.currency),
                date: duplicate.paid_at,
              })}
            </Text>
          ))}
          {!canOverridePayment ? (
            <Text style={styles.warningTitle}>{t('payment.duplicate.forbidden')}</Text>
          ) : null}
        </View>
      ) : null}

      {showOverpaymentWarning ? (
        <View style={styles.warning}>
          <Text style={styles.warningTitle}>{t('payment.overpayment.title')}</Text>
          {!canOverridePayment ? (
            <Text style={styles.warningTitle}>{t('payment.overpayment.forbidden')}</Text>
          ) : null}
        </View>
      ) : null}

      {(showDuplicateWarning || showOverpaymentWarning) && canOverridePayment ? (
        <Field
          label={t('payment.override.reason')}
          hint={
            showDuplicateWarning ? t('payment.duplicate.override') : t('payment.overpayment.override')
          }
          value={overrideReason}
          onChangeText={setOverrideReason}
          maxLength={300}
        />
      ) : null}

      <Button
        label={busy ? t('ocr.confirmation.saving') : t('ocr.confirmation.done')}
        loading={busy}
        disabled={
          (showDuplicateWarning && !canOverridePayment) || (showOverpaymentWarning && !canOverridePayment)
        }
        onPress={() => void submit()}
      />
      <Button label={t('common.back')} variant="ghost" onPress={onBack} disabled={busy} />
      <Button label={t('ocr.confirmation.startOver')} variant="ghost" onPress={onStartOver} disabled={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  section: { fontSize: 18, fontWeight: '700', color: colors.text, paddingTop: 8 },
  muted: { fontSize: 13, lineHeight: 20, color: colors.muted },
  processing: { paddingVertical: 30, gap: 12, alignItems: 'center' },
  image: { width: '100%', height: 260, borderRadius: 16, backgroundColor: colors.brandSoft },
  warning: {
    backgroundColor: '#fffbeb',
    borderColor: '#fde68a',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 6,
  },
  warningTitle: { fontSize: 14, fontWeight: '600', color: '#92400e' },
  warningBody: { fontSize: 13, lineHeight: 20, color: '#92400e' },
});
