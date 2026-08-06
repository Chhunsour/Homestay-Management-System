'use client';

import { useEffect, useRef, useState, useReducer } from 'react';
import type { RefObject } from 'react';
import Link from 'next/link';
import {
  CURRENCIES,
  PAYMENT_METHODS,
  PROOF_MAX_BYTES,
  RECORDABLE_PAYMENT_TYPES,
  bookingPaymentStatus,
  bookingPaymentStatusKey,
  bytesToBase64,
  buildConfirmationPayload,
  depositRequired,
  editedFields,
  fieldErrors,
  formatDateTime,
  formatMoney,
  initialOcrFlowState,
  isOverridable,
  isProofMimeType,
  lowConfidenceFields,
  ocrFlowReducer,
  ocrReviewFieldsSchema,
  OCR_REVIEW_FIELDS,
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
  PropertyPricing,
} from '@homestay/shared';
import { useT } from '@/components/LocaleProvider';
import { Alert, Button, buttonStyles, Checkbox, Field, SelectInput, TextInput } from '@/components/ui';
import {
  confirmOcrPaymentAction,
  issueReceiptAction,
  proofUrlAction,
  runOcrAction,
  type ConfirmOcrPaymentExtras,
  type ConfirmOcrPaymentResult,
  type OcrProofUpload,
} from '@/lib/actions/payments';
import {
  checkOcrAvailabilityAction,
  searchOcrBookingsAction,
  type OcrAvailabilityResult,
} from '@/lib/actions/bookings';
import {
  createCustomerInlineAction,
  searchCustomersAction,
  type CustomerOption,
} from '@/lib/actions/customers';
import { IDLE } from '@/lib/actions/state';
import type { OcrBookingCandidate, RecentProof } from '@/lib/payments';

/** Enough to price a stay and show its name; matches `BookingForm`'s own option shape. */
export type PropertyOption = { id: string; name: string; pricing?: PropertyPricing | null };

/**
 * The Phase 6B flow: pick a screenshot, read it, correct it, match a guest,
 * see a summary. `ocrFlowReducer` (from `@homestay/shared`) owns the state
 * machine — this component is I/O only: it calls the edge function and the
 * customer actions, and dispatches what came back. Nothing here writes a
 * payment or a booking; the confirmation step is where this phase stops.
 */
export function OcrScanFlow({
  businessId,
  timezone,
  recentProofs,
  properties,
  canOverridePrice,
  canOverrideConflict,
  canOverridePayment,
}: {
  businessId: string;
  timezone: string;
  recentProofs: RecentProof[];
  properties: PropertyOption[];
  canOverridePrice: boolean;
  canOverrideConflict: boolean;
  canOverridePayment: boolean;
}) {
  const { t, locale } = useT();
  const [state, dispatch] = useReducer(ocrFlowReducer, initialOcrFlowState(businessId));
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function startOcrWithFile(file: File) {
    if (!isProofMimeType(file.type)) {
      dispatch({ type: 'OCR_FAILED', errorKey: 'ocr.source.error.type' });
      return;
    }
    if (file.size > PROOF_MAX_BYTES) {
      dispatch({ type: 'OCR_FAILED', errorKey: 'ocr.source.error.size' });
      return;
    }
    setPreviewUrl(URL.createObjectURL(file));
    dispatch({ type: 'START_OCR' });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await runOcrAction({
      imageBase64: bytesToBase64(bytes),
      mimeType: file.type,
    });
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
  }

  async function startOcrWithProof(proof: RecentProof) {
    dispatch({ type: 'START_OCR', proofId: proof.id });
    const [result, url] = await Promise.all([
      runOcrAction({ proofId: proof.id }),
      proofUrlAction(proof.storage_path),
    ]);
    setPreviewUrl(url);
    if (result.errorKey || !result.extraction) {
      dispatch({ type: 'OCR_FAILED', errorKey: result.errorKey ?? 'error.generic' });
      return;
    }
    dispatch({
      type: 'OCR_SUCCEEDED',
      extraction: result.extraction,
      duplicates: result.duplicates,
      possibleDuplicate: result.possibleDuplicate,
      proofId: proof.id,
    });
  }

  function retry() {
    dispatch({ type: 'RETRY' });
    if (state.proofId) {
      const proof = recentProofs.find((p) => p.id === state.proofId);
      if (proof) void startOcrWithProof(proof);
      else dispatch({ type: 'OCR_FAILED', errorKey: 'ocr.error.notFound' });
    } else if (fileInputRef.current?.files?.[0]) {
      void startOcrWithFile(fileInputRef.current.files[0]);
    } else {
      dispatch({ type: 'OCR_FAILED', errorKey: 'error.generic' });
    }
  }

  function cancel() {
    if (window.confirm(t('ocr.cancel.confirm'))) {
      setPreviewUrl(null);
      setReviewErrors({});
      dispatch({ type: 'RESTART' });
    }
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

  const money = (amount: number, currency: Currency) => formatMoney(locale, amount, currency);

  /** The fresh screenshot's bytes, still only in the file input — proof-attach reads them here. */
  async function pendingProofUpload(): Promise<OcrProofUpload | null> {
    if (state.proofId) return null; // already stored; nothing new to attach
    const file = fileInputRef.current?.files?.[0];
    if (!file) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { imageBase64: bytesToBase64(bytes), mimeType: file.type, fileName: file.name };
  }

  async function confirmPayment(extra: ConfirmOcrPaymentExtras): Promise<ConfirmOcrPaymentResult> {
    const payload = buildConfirmationPayload(state);
    if (!payload) throw new Error('missing customer or booking selection');
    const proofUpload = await pendingProofUpload();
    return confirmOcrPaymentAction(payload, extra, proofUpload);
  }

  return (
    <div className="space-y-6">
      {state.step === 'source' ? (
        <SourceStep
          errorKey={state.errorKey}
          recentProofs={recentProofs}
          fileInputRef={fileInputRef}
          onFile={startOcrWithFile}
          onProof={startOcrWithProof}
          onManual={() => dispatch({ type: 'SKIP_TO_MANUAL' })}
        />
      ) : null}

      {state.step === 'processing' ? <ProcessingStep /> : null}

      {state.step === 'review' ? (
        <ReviewStep
          state={state}
          previewUrl={previewUrl}
          errors={reviewErrors}
          money={money}
          timezone={timezone}
          onChange={(field, value) => dispatch({ type: 'FIELD_CHANGED', field, value })}
          onRetry={retry}
          onManual={() => dispatch({ type: 'SKIP_TO_MANUAL' })}
          onContinue={continueReview}
          onCancel={cancel}
        />
      ) : null}

      {state.step === 'customer' ? (
        <CustomerStep
          selection={state.customer}
          onSelect={(customer) => dispatch({ type: 'SELECT_CUSTOMER', customer })}
          onContinue={() => dispatch({ type: 'CONTINUE_CUSTOMER' })}
          onBack={() => dispatch({ type: 'BACK' })}
        />
      ) : null}

      {state.step === 'booking' ? (
        <BookingStep
          timezone={timezone}
          properties={properties}
          amount={Number(state.values.amount) || 0}
          currency={(state.values.currency || 'USD') as Currency}
          selection={state.booking}
          canOverridePrice={canOverridePrice}
          canOverrideConflict={canOverrideConflict}
          onSelect={(booking) => dispatch({ type: 'SELECT_BOOKING', booking })}
          onContinue={() => dispatch({ type: 'CONTINUE_BOOKING' })}
          onBack={() => dispatch({ type: 'BACK' })}
        />
      ) : null}

      {state.step === 'confirmation' ? (
        <ConfirmationStep
          state={state}
          money={money}
          canOverridePayment={canOverridePayment}
          onConfirm={confirmPayment}
          onBack={() => dispatch({ type: 'BACK' })}
          onStartOver={() => {
            setPreviewUrl(null);
            dispatch({ type: 'RESTART' });
          }}
        />
      ) : null}
    </div>
  );
}

// --- step 1: source ------------------------------------------------------------

function SourceStep({
  errorKey,
  recentProofs,
  fileInputRef,
  onFile,
  onProof,
  onManual,
}: {
  errorKey: string | null;
  recentProofs: RecentProof[];
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFile: (file: File) => void;
  onProof: (proof: RecentProof) => void;
  onManual: () => void;
}) {
  const { t, locale } = useT();

  return (
    <div className="panel space-y-5 p-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900">
          {t('ocr.step.source.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-600">{t('ocr.step.source.subtitle')}</p>
      </div>

      {errorKey ? <Alert tone="error">{t(errorKey as never)}</Alert> : null}

      <div className="space-y-1.5">
        <label htmlFor="ocr-file" className="block text-sm font-medium text-slate-800">
          {t('ocr.source.upload')}
        </label>
        <input
          ref={fileInputRef}
          id="ocr-file"
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-sm file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-800 hover:file:bg-slate-50"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onFile(file);
          }}
        />
      </div>

      {recentProofs.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-800">{t('ocr.source.existingProof')}</p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {recentProofs.map((proof) => (
              <li key={proof.id}>
                <button
                  type="button"
                  onClick={() => onProof(proof)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-xs text-slate-700 hover:border-brand-300 hover:bg-brand-50"
                >
                  <span className="block truncate font-medium text-slate-900">
                    {proof.payment?.payment_number ?? proof.file_name}
                  </span>
                  {proof.payment ? (
                    <span className="block text-slate-500">
                      {formatMoney(locale, Number(proof.payment.amount), proof.payment.currency)}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Button type="button" variant="ghost" onClick={onManual}>
        {t('ocr.manualEntry')}
      </Button>
      <p className="text-xs text-slate-500">{t('ocr.manualEntry.body')}</p>
    </div>
  );
}

// --- step 2: processing ---------------------------------------------------------

function ProcessingStep() {
  const { t } = useT();
  return (
    <div className="panel space-y-2 p-10 text-center">
      <p className="text-base font-medium text-slate-900">{t('ocr.processing.title')}</p>
      <p className="text-sm text-slate-600">{t('ocr.processing.body')}</p>
    </div>
  );
}

// --- step 3: review ---------------------------------------------------------------

const WARNING_KEYS: Record<OcrWarning, string> = {
  amount_missing: 'ocr.warning.amount_missing',
  currency_ambiguous: 'ocr.warning.currency_ambiguous',
  reference_missing: 'ocr.warning.reference_missing',
  date_missing: 'ocr.warning.date_missing',
  time_missing: 'ocr.warning.time_missing',
  payer_name_missing: 'ocr.warning.payer_name_missing',
  low_overall_confidence: 'ocr.warning.low_overall_confidence',
  provider_error: 'ocr.warning.provider_error',
};

const FIELD_LABEL_KEYS: Record<OcrReviewFieldName, string> = {
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
  previewUrl,
  errors,
  money,
  timezone,
  onChange,
  onRetry,
  onManual,
  onContinue,
  onCancel,
}: {
  state: OcrFlowState;
  previewUrl: string | null;
  errors: Record<string, string>;
  money: (amount: number, currency: Currency) => string;
  timezone: string;
  onChange: (field: OcrReviewFieldName, value: string) => void;
  onRetry: () => void;
  onManual: () => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const { t, locale } = useT();
  const { extraction, values } = state;
  const edited = new Set(editedFields(state.original, values));
  const lowConfidence = new Set(extraction ? lowConfidenceFields(extraction) : []);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="panel space-y-3 p-4">
        <h2 className="font-display text-lg font-semibold text-slate-900">
          {t('ocr.step.review.title')}
        </h2>
        {previewUrl ? (
          // ponytail: plain <img>, same reasoning as ProofManager — a signed
          // or blob URL is not a stable remote source worth an Image config.
          <img
            src={previewUrl}
            alt=""
            className="max-h-[70vh] w-full rounded-lg border border-slate-200 object-contain"
          />
        ) : (
          <p className="text-sm text-slate-600">{t('ocr.manualEntry.notice')}</p>
        )}
      </div>

      <div className="panel space-y-4 p-5">
        <p className="text-sm text-slate-600">{t('ocr.step.review.subtitle')}</p>

        {state.manualEntry ? <Alert tone="info">{t('ocr.manualEntry.notice')}</Alert> : null}

        {extraction ? (
          <p className="text-sm text-slate-700">
            {t('ocr.confidence.overall', {
              percent: Math.round(extraction.overallConfidence * 100),
            })}
          </p>
        ) : null}

        {extraction?.warnings.length ? (
          <Alert tone="info">
            <ul className="list-disc space-y-0.5 pl-4">
              {extraction.warnings.map((warning) => (
                <li key={warning}>{t(WARNING_KEYS[warning] as never)}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {state.possibleDuplicate ? (
          <Alert tone="error">
            <p className="font-medium">{t('payment.duplicate.title')}</p>
            <p>{t('ocr.duplicate.body')}</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {state.duplicates.map((duplicate) => (
                <li key={duplicate.id}>
                  {t('payment.duplicate.match', {
                    number: duplicate.payment_number,
                    amount: money(Number(duplicate.amount), duplicate.currency),
                    date: formatDateTime(locale, duplicate.paid_at, timezone),
                  })}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <ReviewField
            id="payerName"
            label={t(FIELD_LABEL_KEYS.payerName as never)}
            value={values.payerName}
            edited={edited.has('payerName')}
            low={lowConfidence.has('payerName')}
            error={errors.payerName}
            onChange={(v) => onChange('payerName', v)}
          />
          <ReviewField
            id="receiverName"
            label={t(FIELD_LABEL_KEYS.receiverName as never)}
            value={values.receiverName}
            edited={edited.has('receiverName')}
            low={lowConfidence.has('receiverName')}
            error={errors.receiverName}
            onChange={(v) => onChange('receiverName', v)}
          />
          <ReviewField
            id="amount"
            label={t(FIELD_LABEL_KEYS.amount as never)}
            value={values.amount}
            edited={edited.has('amount')}
            low={lowConfidence.has('amount')}
            error={errors.amount ? t(errors.amount as never) : undefined}
            onChange={(v) => onChange('amount', v)}
            type="number"
          />
          <Field
            id="currency"
            label={t('payment.currency' as never)}
            error={errors.currency ? t(errors.currency as never) : undefined}
          >
            <SelectInput
              id="currency"
              value={values.currency}
              invalid={Boolean(errors.currency)}
              onChange={(event) => onChange('currency', event.target.value)}
            >
              <option value="">{t('common.notSet')}</option>
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </SelectInput>
            {lowConfidence.has('currency') ? <ConfidenceHint /> : null}
            {edited.has('currency') ? <EditedHint /> : null}
          </Field>
          <ReviewField
            id="reference"
            label={t(FIELD_LABEL_KEYS.reference as never)}
            value={values.reference}
            edited={edited.has('reference')}
            low={lowConfidence.has('reference')}
            error={errors.reference}
            onChange={(v) => onChange('reference', v)}
          />
          <ReviewField
            id="paymentDate"
            label={t(FIELD_LABEL_KEYS.paymentDate as never)}
            value={values.paymentDate}
            edited={edited.has('paymentDate')}
            low={lowConfidence.has('paymentDate')}
            error={errors.paymentDate ? t(errors.paymentDate as never) : undefined}
            onChange={(v) => onChange('paymentDate', v)}
            type="date"
          />
          <ReviewField
            id="paymentTime"
            label={t(FIELD_LABEL_KEYS.paymentTime as never)}
            value={values.paymentTime}
            edited={edited.has('paymentTime')}
            low={lowConfidence.has('paymentTime')}
            error={errors.paymentTime ? t(errors.paymentTime as never) : undefined}
            onChange={(v) => onChange('paymentTime', v)}
            type="time"
          />
          <Field
            id="method"
            label={t(FIELD_LABEL_KEYS.method as never)}
            error={errors.method ? t(errors.method as never) : undefined}
          >
            <SelectInput
              id="method"
              value={values.method}
              invalid={Boolean(errors.method)}
              onChange={(event) => onChange('method', event.target.value)}
            >
              <option value="">{t('common.notSet')}</option>
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {t(paymentMethodKey(method))}
                </option>
              ))}
            </SelectInput>
            {lowConfidence.has('method') ? <ConfidenceHint /> : null}
            {edited.has('method') ? <EditedHint /> : null}
          </Field>
        </div>

        {values.methodLabel ? (
          // Context for `method`, not independently reviewed — the eight
          // fields above are the ones a reviewer corrects.
          <p className="text-xs text-slate-500">
            {t('ocr.field.methodLabel' as never)}: {values.methodLabel}
          </p>
        ) : null}

        {extraction ? (
          <details className="rounded-lg border border-slate-200 p-3 text-sm">
            <summary className="cursor-pointer font-medium text-slate-700">
              {t('ocr.rawText.toggle')}
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-slate-600">
              {extraction.rawText || t('ocr.rawText.empty')}
            </pre>
          </details>
        ) : null}

        <div className="flex flex-wrap gap-2 pt-2">
          <Button type="button" onClick={onContinue}>
            {t('common.continue')}
          </Button>
          <Button type="button" variant="secondary" onClick={onRetry}>
            {t('ocr.retry')}
          </Button>
          {!state.manualEntry ? (
            <Button type="button" variant="ghost" onClick={onManual}>
              {t('ocr.manualEntry')}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConfidenceHint() {
  const { t } = useT();
  return <p className="text-xs font-medium text-amber-700">{t('ocr.confidence.low')}</p>;
}

function EditedHint() {
  const { t } = useT();
  return <p className="text-xs text-brand-700">{t('ocr.field.edited')}</p>;
}

function ReviewField({
  id,
  label,
  value,
  edited,
  low,
  error,
  onChange,
  type = 'text',
}: {
  id: string;
  label: string;
  value: string;
  edited: boolean;
  low: boolean;
  error?: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <Field id={id} label={label} error={error}>
      <TextInput
        id={id}
        type={type}
        value={value}
        invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value)}
      />
      {low ? <ConfidenceHint /> : null}
      {edited ? <EditedHint /> : null}
    </Field>
  );
}

// --- step 4: customer --------------------------------------------------------

function CustomerStep({
  selection,
  onSelect,
  onContinue,
  onBack,
}: {
  selection: OcrCustomerSelection | null;
  onSelect: (customer: OcrCustomerSelection) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { t } = useT();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerOption[]>([]);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'existing' || !query.trim()) {
      setResults([]);
      return;
    }
    const timeout = setTimeout(() => {
      void searchCustomersAction(query).then(setResults);
    }, 300);
    return () => clearTimeout(timeout);
  }, [mode, query]);

  async function confirmNewCustomer(): Promise<void> {
    if (!newName.trim() || !newPhone.trim()) {
      setErrorKey('validation.required');
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const result = await createCustomerInlineAction({ fullName: newName, phone: newPhone });
      if (result.duplicate) {
        onSelect({
          type: 'existing',
          customerId: result.duplicate.id,
          fullName: result.duplicate.name,
        });
        onContinue();
        return;
      }
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
    <div className="panel space-y-4 p-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900">
          {t('ocr.step.customer.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-600">{t('ocr.step.customer.subtitle')}</p>
      </div>

      {errorKey ? <Alert tone="error">{t(errorKey as never)}</Alert> : null}

      <div className="flex gap-2">
        <Button
          type="button"
          variant={mode === 'existing' ? 'primary' : 'secondary'}
          onClick={() => setMode('existing')}
        >
          {t('booking.customer.existing')}
        </Button>
        <Button
          type="button"
          variant={mode === 'new' ? 'primary' : 'secondary'}
          onClick={() => setMode('new')}
        >
          {t('booking.customer.new')}
        </Button>
      </div>

      {mode === 'existing' ? (
        <div className="space-y-3">
          <Field id="customerSearch" label={t('ocr.customer.search.placeholder')}>
            <TextInput
              id="customerSearch"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('ocr.customer.search.placeholder')}
            />
          </Field>
          {query.trim() && results.length === 0 ? (
            <p className="text-sm text-slate-600">{t('ocr.customer.search.empty')}</p>
          ) : null}
          <ul className="space-y-2">
            {results.map((customer) => {
              const isSelected =
                selection?.type === 'existing' && selection.customerId === customer.id;
              return (
                <li
                  key={customer.id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-900">{customer.full_name}</p>
                    <p className="text-xs text-slate-500">{customer.phone}</p>
                  </div>
                  <Button
                    type="button"
                    variant={isSelected ? 'primary' : 'secondary'}
                    onClick={() =>
                      onSelect({
                        type: 'existing',
                        customerId: customer.id,
                        fullName: customer.full_name,
                      })
                    }
                  >
                    {isSelected ? t('ocr.customer.selected') : t('ocr.customer.select')}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="newCustomerName" label={t('booking.customer.name')}>
            <TextInput
              id="newCustomerName"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              maxLength={160}
            />
          </Field>
          <Field id="newCustomerPhone" label={t('booking.customer.phone')}>
            <TextInput
              id="newCustomerPhone"
              value={newPhone}
              onChange={(event) => setNewPhone(event.target.value)}
              maxLength={32}
            />
          </Field>
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-2">
        {mode === 'new' ? (
          <Button type="button" disabled={busy} onClick={() => void confirmNewCustomer()}>
            {t('common.continue')}
          </Button>
        ) : (
          <Button type="button" disabled={!selection} onClick={onContinue}>
            {t('common.continue')}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onBack}>
          {t('common.back')}
        </Button>
      </div>
    </div>
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

/** Which of the four deposit situations this outcome lands in — pure copy, no verdict. */
function depositMessageKey(outcome: PaymentOutcome): string | null {
  if (outcome.overpaid) return null; // its own, louder warning
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
  const { t } = useT();
  const messageKey = depositMessageKey(outcome);
  return (
    <div className="space-y-3">
      <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        <SummaryRow label={t('ocr.booking.summary.total')} value={money(outcome.bookingTotal, currency)} />
        <SummaryRow label={t('ocr.booking.summary.deposit')} value={money(outcome.depositRequired, currency)} />
        <SummaryRow label={t('ocr.booking.summary.paid')} value={money(outcome.previouslyPaid, currency)} />
        <SummaryRow label={t('ocr.booking.summary.newTotal')} value={money(outcome.newTotal, currency)} />
        <SummaryRow label={t('ocr.booking.summary.remaining')} value={money(outcome.remaining, currency)} />
        <SummaryRow
          label={t('ocr.booking.summary.statusAfter')}
          value={t(bookingPaymentStatusKey(outcome.status))}
        />
      </dl>
      {outcome.overpaid ? (
        <Alert tone="error">{t('payment.overpayment.warning', { amount: money(outcome.newTotal - outcome.bookingTotal, currency) })}</Alert>
      ) : messageKey ? (
        <Alert tone="info">{t(messageKey as never)}</Alert>
      ) : null}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 px-4 py-2.5 text-sm">
      <dt className="text-slate-600">{label}</dt>
      <dd className="font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function BookingStep({
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
  timezone: string;
  properties: PropertyOption[];
  amount: number;
  currency: Currency;
  selection: OcrBookingSelection | null;
  canOverridePrice: boolean;
  canOverrideConflict: boolean;
  onSelect: (selection: OcrBookingSelection | null) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { t, locale } = useT();
  const [mode, setMode] = useState<'existing' | 'new'>(selection?.type ?? 'existing');

  const [search, setSearch] = useState('');
  const [propertyFilter, setPropertyFilter] = useState('');
  const [results, setResults] = useState<OcrBookingCandidate[]>([]);

  useEffect(() => {
    if (mode !== 'existing') return;
    const timeout = setTimeout(() => {
      void searchOcrBookingsAction({
        search: search.trim() || undefined,
        propertyId: propertyFilter || undefined,
      }).then(setResults);
    }, 300);
    return () => clearTimeout(timeout);
  }, [mode, search, propertyFilter]);

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
  const [checkInAt, setCheckInAt] = useState('');
  const [checkOutAt, setCheckOutAt] = useState('');
  const [overridePrice, setOverridePrice] = useState(false);
  const [finalPriceInput, setFinalPriceInput] = useState('');
  const [priceReason, setPriceReason] = useState('');
  const [note, setNote] = useState('');
  const [conflictOverride, setConflictOverride] = useState(false);
  const [conflictReason, setConflictReason] = useState('');
  const [availability, setAvailability] = useState<OcrAvailabilityResult | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);

  const property = properties.find((row) => row.id === propertyId);
  const validRange = Boolean(checkInAt && checkOutAt && checkOutAt > checkInAt);
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
    setCheckingAvailability(true);
    const timeout = setTimeout(() => {
      void checkOcrAvailabilityAction({ propertyId, checkInAt, checkOutAt })
        .then(setAvailability)
        .finally(() => setCheckingAvailability(false));
    }, 400);
    return () => clearTimeout(timeout);
  }, [mode, propertyId, checkInAt, checkOutAt, validRange]);

  const overridable = availability ? isOverridable(availability.conflicts) && canOverrideConflict : false;
  const blocked = Boolean(availability && !availability.available);
  const priceOverridden = overridePrice && finalPriceInput.trim() !== '';

  useEffect(() => {
    if (mode !== 'new') return;
    if (!property || !preview) return void onSelect(null);
    if (priceOverridden && priceReason.trim().length < 3) return void onSelect(null);
    if (blocked && !(overridable && conflictOverride && conflictReason.trim().length >= 3)) {
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
      conflictOverride: blocked && conflictOverride,
      conflictOverrideReason: conflictReason,
      note,
    });
    // Runs whenever any input the booking depends on changes; onSelect is a stable dispatch.
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
    conflictOverride,
    conflictReason,
    note,
  ]);

  function switchMode(next: 'existing' | 'new'): void {
    setMode(next);
    onSelect(null);
  }

  const outcome = selection ? computeOutcome(selection, amount) : null;
  const mismatch = selection && currency && selection.currency !== currency;

  return (
    <div className="panel space-y-5 p-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900">
          {t('ocr.step.booking.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-600">{t('ocr.step.booking.subtitle')}</p>
      </div>

      <div className="flex gap-2">
        <Button type="button" variant={mode === 'existing' ? 'primary' : 'secondary'} onClick={() => switchMode('existing')}>
          {t('ocr.booking.mode.existing')}
        </Button>
        <Button type="button" variant={mode === 'new' ? 'primary' : 'secondary'} onClick={() => switchMode('new')}>
          {t('ocr.booking.mode.new')}
        </Button>
      </div>

      {mode === 'existing' ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="bookingSearch" label={t('ocr.booking.search.placeholder')}>
              <TextInput
                id="bookingSearch"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('ocr.booking.search.placeholder')}
              />
            </Field>
            <Field id="bookingPropertyFilter" label={t('ocr.booking.filter.property')}>
              <SelectInput
                id="bookingPropertyFilter"
                value={propertyFilter}
                onChange={(event) => setPropertyFilter(event.target.value)}
              >
                <option value="">{t('ocr.booking.filter.allProperties')}</option>
                {properties.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>

          {results.length === 0 ? (
            <p className="text-sm text-slate-600">{t('ocr.booking.search.empty')}</p>
          ) : (
            <ul className="space-y-2">
              {results.map((candidate) => {
                const isSelected = selection?.type === 'existing' && selection.bookingId === candidate.id;
                return (
                  <li
                    key={candidate.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5"
                  >
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {candidate.booking_number} · {candidate.property_name}
                      </p>
                      <p className="text-xs text-slate-500">
                        {candidate.customer_name} · {formatDateTime(locale, candidate.check_in_at, timezone)} →{' '}
                        {formatDateTime(locale, candidate.check_out_at, timezone)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {money(candidate.balance, candidate.currency)} {t('ocr.booking.summary.remaining').toLowerCase()} ·{' '}
                        {t(bookingPaymentStatusKey(candidate.payment_status))}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant={isSelected ? 'primary' : 'secondary'}
                      onClick={() => pickExisting(candidate)}
                    >
                      {isSelected ? t('ocr.booking.selected') : t('ocr.booking.select')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Field id="newBookingProperty" label={t('booking.property')}>
            <SelectInput
              id="newBookingProperty"
              value={propertyId}
              onChange={(event) => setPropertyId(event.target.value)}
            >
              <option value="">{t('common.notSet')}</option>
              {properties.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </SelectInput>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="newBookingCheckIn" label={t('booking.checkIn')}>
              <TextInput
                id="newBookingCheckIn"
                type="datetime-local"
                value={checkInAt}
                onChange={(event) => setCheckInAt(event.target.value)}
              />
            </Field>
            <Field id="newBookingCheckOut" label={t('booking.checkOut')}>
              <TextInput
                id="newBookingCheckOut"
                type="datetime-local"
                value={checkOutAt}
                onChange={(event) => setCheckOutAt(event.target.value)}
              />
            </Field>
          </div>

          {preview ? (
            <div className="rounded-sm border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
              <p className="font-medium text-slate-900">
                {t('booking.price.calculated')}: {money(preview.total, preview.currency)}
              </p>
              <p className="mt-0.5 text-slate-600">
                {t('booking.days', { count: String(preview.days.length) })} ·{' '}
                {t('booking.price.breakdown', {
                  weekdayCount: String(preview.weekdayCount),
                  weekendCount: String(preview.weekendCount),
                })}
              </p>
            </div>
          ) : null}

          {checkingAvailability ? (
            <p className="text-sm text-slate-600">{t('ocr.booking.availability.checking')}</p>
          ) : availability && validRange ? (
            availability.available ? (
              <Alert tone="info">{t('booking.conflict.free')}</Alert>
            ) : (
              <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                <p className="font-medium">{t('booking.conflict.title')}</p>
                <ul className="mt-2 space-y-1">
                  {availability.conflicts.map((conflict: BookingConflict) => (
                    <li key={conflict.id}>
                      {conflict.kind === 'booking'
                        ? t('availability.conflict.booking', { number: conflict.label })
                        : conflict.label}
                    </li>
                  ))}
                </ul>
                {overridable ? (
                  <div className="mt-3 space-y-2 border-t border-amber-200 pt-3">
                    <Checkbox
                      id="newBookingConflictOverride"
                      label={t('booking.conflict.override')}
                      checked={conflictOverride}
                      onChange={(event) => setConflictOverride(event.target.checked)}
                    />
                    <Field id="newBookingConflictReason" label={t('booking.conflict.reason')}>
                      <TextInput
                        id="newBookingConflictReason"
                        value={conflictReason}
                        onChange={(event) => setConflictReason(event.target.value)}
                        maxLength={300}
                      />
                    </Field>
                  </div>
                ) : (
                  <p className="mt-2 font-medium">
                    {isOverridable(availability.conflicts)
                      ? t('booking.conflict.forbidden')
                      : t('booking.error.propertyUnavailable')}
                  </p>
                )}
              </div>
            )
          ) : null}

          {canOverridePrice ? (
            <>
              <Checkbox
                id="newBookingOverridePrice"
                label={t('booking.price.override')}
                checked={overridePrice}
                onChange={(event) => setOverridePrice(event.target.checked)}
              />
              {overridePrice ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="newBookingFinalPrice" label={t('booking.price.final')}>
                    <TextInput
                      id="newBookingFinalPrice"
                      type="number"
                      min={0}
                      step="0.01"
                      value={finalPriceInput}
                      onChange={(event) => setFinalPriceInput(event.target.value)}
                    />
                  </Field>
                  <Field id="newBookingPriceReason" label={t('booking.price.override.reason')}>
                    <TextInput
                      id="newBookingPriceReason"
                      value={priceReason}
                      onChange={(event) => setPriceReason(event.target.value)}
                      maxLength={300}
                    />
                  </Field>
                </div>
              ) : null}
            </>
          ) : null}

          <Field id="newBookingNote" label={t('booking.note')}>
            <TextInput id="newBookingNote" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} />
          </Field>
        </div>
      )}

      {selection && outcome ? (
        <>
          {mismatch ? (
            <Alert tone="info">
              {t('ocr.currency.mismatch', { from: currency, to: selection.currency })}
            </Alert>
          ) : null}
          <OutcomeSummary outcome={outcome} currency={selection.currency} money={money} />
        </>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-2">
        <Button type="button" disabled={!selection} onClick={onContinue}>
          {t('common.continue')}
        </Button>
        <Button type="button" variant="ghost" onClick={onBack}>
          {t('common.back')}
        </Button>
      </div>
    </div>
  );

  function money(amountValue: number, currencyValue: Currency): string {
    return formatMoney(locale, amountValue, currencyValue);
  }
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
  const { t } = useT();
  const payload = buildConfirmationPayload(state);

  const outcome = payload ? computeOutcome(payload.booking, Number(payload.values.amount) || 0) : null;
  const [paymentType, setPaymentType] = useState<(typeof RECORDABLE_PAYMENT_TYPES)[number]>('deposit');
  const [duplicateOverride, setDuplicateOverride] = useState(false);
  const [overpaymentOverride, setOverpaymentOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ConfirmOcrPaymentResult | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [issuingReceipt, setIssuingReceipt] = useState(false);

  useEffect(() => {
    if (outcome) setPaymentType(defaultPaymentType(outcome));
    // Only re-default when the underlying booking/amount actually changes.
  }, [outcome?.newTotal, outcome?.bookingTotal]);

  if (!payload || !outcome) return null;
  const { values } = payload;
  const currency = payload.booking.currency;
  const showDuplicateWarning = payload.possibleDuplicate;
  const showOverpaymentWarning = outcome.overpaid;
  const needsOverrideReason =
    (duplicateOverride && showDuplicateWarning) || (overpaymentOverride && showOverpaymentWarning);

  async function submit(): Promise<void> {
    setBusy(true);
    setErrorKey(null);
    setFieldErrs({});
    try {
      const outcome_ = await onConfirm({
        paymentType,
        duplicateOverride,
        overpaymentOverride,
        overrideReason,
      });
      if (outcome_.errorKey) {
        setErrorKey(outcome_.errorKey);
        setFieldErrs(outcome_.fieldErrors);
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
      const formData = new FormData();
      formData.set('bookingId', result.bookingId);
      if (result.paymentId) formData.set('paymentId', result.paymentId);
      formData.set('language', 'en');
      const outcome_ = await issueReceiptAction(IDLE, formData);
      if (outcome_.receiptId) setReceiptId(outcome_.receiptId);
    } finally {
      setIssuingReceipt(false);
    }
  }

  if (result?.bookingId) {
    return (
      <div className="panel space-y-4 p-6">
        <Alert tone="info">{t('ocr.confirmation.success')}</Alert>
        <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          <SummaryRow
            label={t('booking.number')}
            value={result.bookingNumber ?? ''}
          />
          <SummaryRow label={t('payment.amount')} value={money(Number(values.amount), currency)} />
          <SummaryRow
            label={t('ocr.booking.summary.remaining')}
            value={money(outcome.remaining, currency)}
          />
        </dl>
        <div className="flex flex-wrap gap-2 pt-2">
          <Link href={`/bookings/${result.bookingId}`} className={buttonStyles('primary')}>
            {t('booking.detail.title', { number: result.bookingNumber ?? '' })}
          </Link>
          {result.paymentId ? (
            <Link href={`/payments/${result.paymentId}`} className={buttonStyles('secondary')}>
              {t('payment.detail.title', { number: result.paymentNumber ?? '' })}
            </Link>
          ) : null}
          {receiptId ? (
            <Link href={`/receipts/${receiptId}`} className={buttonStyles('secondary')}>
              {t('receipt.title')}
            </Link>
          ) : (
            <Button type="button" variant="secondary" disabled={issuingReceipt} onClick={() => void generateReceipt()}>
              {t('receipt.issue')}
            </Button>
          )}
        </div>
        <Button type="button" variant="ghost" onClick={onStartOver}>
          {t('ocr.confirmation.startOver')}
        </Button>
      </div>
    );
  }

  return (
    <div className="panel space-y-4 p-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-slate-900">
          {t('ocr.step.confirmation.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-600">{t('ocr.step.confirmation.subtitle')}</p>
      </div>

      <Alert tone="info">{t('ocr.confirmation.notice')}</Alert>
      {state.manualEntry ? <Alert tone="info">{t('ocr.confirmation.manualEntry.badge')}</Alert> : null}
      {errorKey ? <Alert tone="error">{t(errorKey as never)}</Alert> : null}

      <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {OCR_REVIEW_FIELDS.map((field) => (
          <div key={field} className="flex justify-between gap-4 px-4 py-2.5 text-sm">
            <dt className="text-slate-600">{t(FIELD_LABEL_KEYS[field] as never)}</dt>
            <dd className="font-medium text-slate-900">
              {field === 'amount' && values.amount
                ? money(Number(values.amount), currency)
                : field === 'method' && values.method
                  ? t(paymentMethodKey(values.method as PaymentMethod))
                  : (values[field] as string) || t('common.notSet')}
            </dd>
          </div>
        ))}
        <SummaryRow
          label={t('payment.customer')}
          value={
            payload.customer.type === 'existing'
              ? t('ocr.confirmation.customer.existing', { name: payload.customer.fullName })
              : t('ocr.confirmation.customer.new', { name: payload.customer.fullName })
          }
        />
        <SummaryRow
          label={t('booking.title')}
          value={
            payload.booking.type === 'existing'
              ? t('ocr.confirmation.booking.existing', { number: payload.booking.bookingNumber })
              : t('ocr.confirmation.booking.new', { property: payload.booking.propertyName })
          }
        />
      </dl>

      <OutcomeSummary outcome={outcome} currency={currency} money={money} />

      <Field id="ocrPaymentType" label={t('payment.type' as never)}>
        <SelectInput
          id="ocrPaymentType"
          value={paymentType}
          onChange={(event) =>
            setPaymentType(event.target.value as (typeof RECORDABLE_PAYMENT_TYPES)[number])
          }
        >
          {RECORDABLE_PAYMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(paymentTypeKey(type))}
            </option>
          ))}
        </SelectInput>
      </Field>

      {showDuplicateWarning ? (
        <div className="rounded-sm border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
          <p className="font-medium">{t('payment.duplicate.title')}</p>
          <p>{t('ocr.duplicate.body')}</p>
          <ul className="mt-2 space-y-0.5">
            {payload.duplicates.map((duplicate) => (
              <li key={duplicate.id}>
                {t('payment.duplicate.match', {
                  number: duplicate.payment_number,
                  amount: money(Number(duplicate.amount), duplicate.currency),
                  date: duplicate.paid_at,
                })}
              </li>
            ))}
          </ul>
          {canOverridePayment ? (
            <div className="mt-2">
              <Checkbox
                id="duplicateOverride"
                label={t('payment.duplicate.override')}
                checked={duplicateOverride}
                onChange={(event) => setDuplicateOverride(event.target.checked)}
              />
            </div>
          ) : (
            <p className="mt-2 font-medium">{t('payment.duplicate.forbidden')}</p>
          )}
        </div>
      ) : null}

      {showOverpaymentWarning ? (
        <div className="rounded-sm border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
          <p className="font-medium">{t('payment.overpayment.title')}</p>
          {canOverridePayment ? (
            <div className="mt-2">
              <Checkbox
                id="overpaymentOverride"
                label={t('payment.overpayment.override')}
                checked={overpaymentOverride}
                onChange={(event) => setOverpaymentOverride(event.target.checked)}
              />
            </div>
          ) : (
            <p className="mt-2 font-medium">{t('payment.overpayment.forbidden')}</p>
          )}
        </div>
      ) : null}

      {needsOverrideReason ? (
        <Field
          id="overrideReason"
          label={t('payment.override.reason')}
          error={fieldErrs.overrideReason ? t(fieldErrs.overrideReason as never) : undefined}
        >
          <TextInput
            id="overrideReason"
            value={overrideReason}
            onChange={(event) => setOverrideReason(event.target.value)}
            maxLength={300}
            invalid={Boolean(fieldErrs.overrideReason)}
          />
        </Field>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-2">
        <Button
          type="button"
          disabled={
            busy ||
            (showDuplicateWarning && !canOverridePayment) ||
            (showOverpaymentWarning && !canOverridePayment)
          }
          onClick={() => void submit()}
        >
          {busy ? t('ocr.confirmation.saving') : t('ocr.confirmation.done')}
        </Button>
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          {t('common.back')}
        </Button>
        <Button type="button" variant="ghost" onClick={onStartOver} disabled={busy}>
          {t('ocr.confirmation.startOver')}
        </Button>
      </div>
    </div>
  );
}
