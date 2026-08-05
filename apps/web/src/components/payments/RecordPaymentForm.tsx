'use client';

import { useActionState, useState } from 'react';
import {
  PAYMENT_METHODS,
  RECORDABLE_PAYMENT_TYPES,
  canOverridePayment,
  formatMoney,
  paymentMethodKey,
  paymentTypeKey,
} from '@homestay/shared';
import type { BookingPaymentSummary, Role } from '@homestay/shared';
import { recordPaymentAction, type PaymentActionState } from '@/lib/actions/payments';
import { IDLE } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { SubmitButton } from '@/components/SubmitButton';
import {
  Alert,
  Checkbox,
  Field,
  SelectInput,
  TextArea,
  TextInput,
} from '@/components/ui';

/**
 * Recording money. Amount and method are the only required fields — a guest who
 * sends $20 towards a $200 booking has paid $20, and that is saved as a partial
 * payment without argument. Only two things stop a save: a transaction reference
 * that is already on another payment, and an amount that takes the booking past
 * its total. Both come back from the server with the evidence attached, and only
 * an owner or manager is offered the override.
 */
export function RecordPaymentForm({
  bookingId,
  summary,
  role,
}: {
  bookingId: string;
  summary: BookingPaymentSummary;
  role: Role;
}) {
  const { locale, t } = useT();
  const [state, action] = useActionState<PaymentActionState, FormData>(recordPaymentAction, IDLE);
  const [showOverride, setShowOverride] = useState(false);

  const canOverride = canOverridePayment(role);
  const blocked = (state.duplicates?.length ?? 0) > 0 || Boolean(state.overpayment);
  const balance = Number(summary.balance);
  const deposit = Math.max(Number(summary.deposit_required) - Number(summary.net_paid), 0);
  const money = (value: number) => formatMoney(locale, value, summary.currency);

  return (
    <form action={action} className="space-y-4 border-t border-slate-100 p-5">
      <input type="hidden" name="bookingId" value={bookingId} />

      {state.status === 'success' && state.messageKey ? (
        <Alert tone="success">{t(state.messageKey)}</Alert>
      ) : null}

      {state.duplicates?.length ? (
        <div className="space-y-2 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-medium">{t('payment.duplicate.title')}</p>
          <p>{state.messageKey ? t(state.messageKey) : t('payment.duplicate.warning')}</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {state.duplicates.map((duplicate) => (
              <li key={duplicate.id}>
                {t('payment.duplicate.match', {
                  number: duplicate.payment_number,
                  amount: money(Number(duplicate.amount)),
                  date: new Date(duplicate.paid_at).toLocaleString(locale),
                })}
              </li>
            ))}
          </ul>
          {!canOverride ? <p>{t('payment.duplicate.forbidden')}</p> : null}
        </div>
      ) : null}

      {state.overpayment ? (
        <div className="space-y-1 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-medium">{t('payment.overpayment.title')}</p>
          <p>
            {t('payment.overpayment.warning', {
              amount: formatMoney(
                locale,
                state.overpayment.net_paid + state.overpayment.amount - state.overpayment.booking_total,
                state.overpayment.currency,
              ),
            })}
          </p>
          {!canOverride ? <p>{t('payment.overpayment.forbidden')}</p> : null}
        </div>
      ) : null}

      {state.status === 'error' && state.messageKey && !blocked ? (
        <Alert tone="error">{t(state.messageKey)}</Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="amount"
          label={t('payment.amount')}
          error={state.fieldErrors?.amount ? t(state.fieldErrors.amount as 'validation.price') : undefined}
          hint={balance > 0 ? t('payment.summary.due', { amount: money(balance) }) : undefined}
        >
          <TextInput
            id="amount"
            name="amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            required
            autoFocus
            defaultValue={deposit > 0 ? deposit.toFixed(2) : undefined}
            invalid={Boolean(state.fieldErrors?.amount)}
          />
        </Field>

        <Field id="method" label={t('payment.method')}>
          <SelectInput id="method" name="method" defaultValue="aba" required>
            {PAYMENT_METHODS.map((method) => (
              <option key={method} value={method}>
                {t(paymentMethodKey(method))}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Field id="paymentType" label={t('payment.type')}>
          <SelectInput
            id="paymentType"
            name="paymentType"
            defaultValue={Number(summary.net_paid) > 0 ? 'balance' : 'deposit'}
          >
            {RECORDABLE_PAYMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(paymentTypeKey(type))}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Field id="paidAt" label={t('payment.date')} hint={t('payment.date.hint')}>
          <TextInput id="paidAt" name="paidAt" type="datetime-local" />
        </Field>

        <Field
          id="reference"
          label={t('payment.reference')}
          hint={t('payment.reference.hint')}
          error={
            state.fieldErrors?.reference
              ? t(state.fieldErrors.reference as 'validation.required')
              : undefined
          }
        >
          <TextInput
            id="reference"
            name="reference"
            maxLength={120}
            invalid={Boolean(state.fieldErrors?.reference)}
          />
        </Field>

        <Field id="payerName" label={t('payment.payer')} hint={t('payment.payer.hint')}>
          <TextInput id="payerName" name="payerName" maxLength={160} />
        </Field>
      </div>

      <Field id="note" label={t('payment.note')}>
        <TextArea id="note" name="note" maxLength={1000} />
      </Field>

      {/* The override only appears once the server has actually refused, and
          only for someone allowed to overrule it. Staff get the message and a
          person to ask. */}
      {blocked && canOverride ? (
        <div className="space-y-3 rounded-sm border border-slate-200 bg-slate-50 p-3">
          <Checkbox
            id="override"
            checked={showOverride}
            onChange={(event) => setShowOverride(event.target.checked)}
            label={
              state.overpayment
                ? t('payment.overpayment.override')
                : t('payment.duplicate.override')
            }
          />
          {showOverride ? (
            <>
              {state.duplicates?.length ? (
                <input type="hidden" name="duplicateOverride" value="on" />
              ) : null}
              {state.overpayment ? (
                <input type="hidden" name="overpaymentOverride" value="on" />
              ) : null}
              <Field
                id="overrideReason"
                label={t('payment.override.reason')}
                error={
                  state.fieldErrors?.overrideReason
                    ? t('payment.reason.required')
                    : undefined
                }
              >
                <TextInput
                  id="overrideReason"
                  name="overrideReason"
                  required
                  minLength={3}
                  maxLength={300}
                  invalid={Boolean(state.fieldErrors?.overrideReason)}
                />
              </Field>
            </>
          ) : null}
        </div>
      ) : null}

      <SubmitButton labelKey="payment.record" />
    </form>
  );
}
