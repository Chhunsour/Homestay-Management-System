'use client';

import { useActionState, useState } from 'react';
import {
  LOCALES,
  PAYMENT_METHODS,
  canCorrectPayment,
  canRefundPayment,
  canVerifyPayment,
  canVoidPayment,
  formatMoney,
  paymentMethodKey,
} from '@homestay/shared';
import type { Payment, Role } from '@homestay/shared';
import {
  correctPaymentAction,
  issueReceiptAction,
  refundPaymentAction,
  verifyPaymentAction,
  voidPaymentAction,
  type PaymentActionState,
} from '@/lib/actions/payments';
import { IDLE } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { SubmitButton } from '@/components/SubmitButton';
import { Alert, Button, Field, SelectInput, TextArea, TextInput } from '@/components/ui';

/**
 * Everything that can happen to a payment after it is recorded. Nothing here
 * deletes: a void keeps the row and stops it counting, a correction keeps the
 * old amount in the audit trail, a refund is its own row. What each role may do
 * is decided in the database — this only decides what is worth showing.
 */
export function PaymentActions({
  payment,
  role,
  refundable,
}: {
  payment: Payment;
  role: Role;
  /** How much of this payment has not been refunded yet. */
  refundable: number;
}) {
  const { locale, t } = useT();
  const [open, setOpen] = useState<'correct' | 'refund' | 'void' | 'receipt' | null>(null);

  const [verifyState, verify] = useActionState<PaymentActionState, FormData>(verifyPaymentAction, IDLE);
  const [correctState, correct] = useActionState<PaymentActionState, FormData>(correctPaymentAction, IDLE);
  const [refundState, refund] = useActionState<PaymentActionState, FormData>(refundPaymentAction, IDLE);
  const [voidState, voidIt] = useActionState<PaymentActionState, FormData>(voidPaymentAction, IDLE);
  const [receiptState, receipt] = useActionState<PaymentActionState, FormData>(issueReceiptAction, IDLE);

  const states = [verifyState, correctState, refundState, voidState, receiptState];
  const message = states.find((state) => state.status !== 'idle' && state.messageKey);

  const hidden = (
    <>
      <input type="hidden" name="paymentId" value={payment.id} />
      <input type="hidden" name="bookingId" value={payment.booking_id} />
    </>
  );

  return (
    <div className="space-y-4 border-t border-slate-100 p-5">
      {message?.messageKey ? (
        <Alert tone={message.status === 'error' ? 'error' : 'success'}>{t(message.messageKey)}</Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canVerifyPayment(role, payment) ? (
          <form action={verify}>
            {hidden}
            <SubmitButton labelKey="payment.verify" variant="secondary" />
          </form>
        ) : null}

        {canCorrectPayment(role, payment) ? (
          <Button variant="secondary" onClick={() => setOpen(open === 'correct' ? null : 'correct')}>
            {t('payment.correct')}
          </Button>
        ) : null}

        {canRefundPayment(role, payment) && refundable > 0 ? (
          <Button variant="secondary" onClick={() => setOpen(open === 'refund' ? null : 'refund')}>
            {t('payment.refund')}
          </Button>
        ) : null}

        <Button variant="secondary" onClick={() => setOpen(open === 'receipt' ? null : 'receipt')}>
          {t('receipt.issue')}
        </Button>

        {canVoidPayment(role, payment) ? (
          <Button
            variant="ghost"
            className="text-red-700 hover:bg-red-50"
            onClick={() => setOpen(open === 'void' ? null : 'void')}
          >
            {t('payment.void')}
          </Button>
        ) : null}
      </div>

      {open === 'correct' ? (
        <form action={correct} className="space-y-3 rounded-sm border border-slate-200 bg-slate-50 p-3">
          {hidden}
          <p className="text-sm font-medium text-slate-900">{t('payment.correct.title')}</p>
          <p className="text-xs text-slate-600">{t('payment.correct.body')}</p>
          {payment.status === 'verified' ? (
            <p className="text-xs text-amber-800">{t('payment.correct.reverify')}</p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="correct-amount"
              label={t('payment.amount')}
              error={
                correctState.fieldErrors?.amount
                  ? t(correctState.fieldErrors.amount as 'validation.price')
                  : undefined
              }
            >
              <TextInput
                id="correct-amount"
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                required
                defaultValue={Number(payment.amount).toFixed(2)}
              />
            </Field>
            <Field id="correct-method" label={t('payment.method')}>
              <SelectInput id="correct-method" name="method" defaultValue={payment.method}>
                {PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {t(paymentMethodKey(method))}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field id="correct-reference" label={t('payment.reference')}>
              <TextInput
                id="correct-reference"
                name="reference"
                maxLength={120}
                defaultValue={payment.reference ?? ''}
              />
            </Field>
            <Field id="correct-payer" label={t('payment.payer')}>
              <TextInput
                id="correct-payer"
                name="payerName"
                maxLength={160}
                defaultValue={payment.payer_name ?? ''}
              />
            </Field>
          </div>
          <Field
            id="correct-reason"
            label={t('payment.reason')}
            error={correctState.fieldErrors?.reason ? t('payment.reason.required') : undefined}
          >
            <TextArea id="correct-reason" name="reason" required minLength={3} maxLength={300} />
          </Field>
          <SubmitButton labelKey="payment.correct" />
        </form>
      ) : null}

      {open === 'refund' ? (
        <form action={refund} className="space-y-3 rounded-sm border border-slate-200 bg-slate-50 p-3">
          {hidden}
          <p className="text-sm font-medium text-slate-900">{t('payment.refund.title')}</p>
          <Field
            id="refund-amount"
            label={t('payment.refund.amount')}
            hint={t('payment.refund.max', {
              amount: formatMoney(locale, refundable, payment.currency),
            })}
            error={
              refundState.fieldErrors?.amount
                ? t(refundState.fieldErrors.amount as 'validation.price')
                : undefined
            }
          >
            <TextInput
              id="refund-amount"
              name="amount"
              type="number"
              step="0.01"
              min="0.01"
              max={refundable}
              required
              defaultValue={refundable.toFixed(2)}
            />
          </Field>
          <Field id="refund-method" label={t('payment.method')}>
            <SelectInput id="refund-method" name="method" defaultValue={payment.method}>
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {t(paymentMethodKey(method))}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field
            id="refund-reason"
            label={t('payment.reason')}
            error={refundState.fieldErrors?.reason ? t('payment.reason.required') : undefined}
          >
            <TextArea id="refund-reason" name="reason" required minLength={3} maxLength={300} />
          </Field>
          <SubmitButton labelKey="payment.refund" />
        </form>
      ) : null}

      {open === 'void' ? (
        <form action={voidIt} className="space-y-3 rounded-sm border border-red-200 bg-red-50 p-3">
          {hidden}
          <p className="text-sm font-medium text-red-900">{t('payment.void.title')}</p>
          <p className="text-xs text-red-800">{t('payment.void.body')}</p>
          <Field
            id="void-reason"
            label={t('payment.reason')}
            error={voidState.fieldErrors?.reason ? t('payment.reason.required') : undefined}
          >
            <TextArea id="void-reason" name="reason" required minLength={3} maxLength={300} />
          </Field>
          <SubmitButton labelKey="payment.void" variant="secondary" />
        </form>
      ) : null}

      {open === 'receipt' ? (
        <form action={receipt} className="space-y-3 rounded-sm border border-slate-200 bg-slate-50 p-3">
          {hidden}
          <Field id="receipt-language" label={t('receipt.language')}>
            <SelectInput id="receipt-language" name="language" defaultValue={locale}>
              {LOCALES.map((value) => (
                <option key={value} value={value}>
                  {t(value === 'km' ? 'common.khmer' : 'common.english')}
                </option>
              ))}
            </SelectInput>
          </Field>
          <SubmitButton labelKey="receipt.issue" />
          {receiptState.receiptId ? (
            <a
              href={`/receipts/${receiptState.receiptId}`}
              target="_blank"
              rel="noreferrer"
              className="ml-3 text-sm font-medium text-brand-800 hover:underline"
            >
              {t('receipt.preview')}
            </a>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
