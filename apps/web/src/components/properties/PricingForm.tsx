'use client';

import { useActionState } from 'react';
import { CURRENCIES, type PropertyPricing, type TranslationKey } from '@homestay/shared';
import { updatePricingAction } from '@/lib/actions/properties';
import { IDLE } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { SubmitButton } from '@/components/SubmitButton';
import { Alert, Field, SelectInput, TextInput } from '@/components/ui';

export function PricingForm({
  propertyId,
  pricing,
  defaultCurrency,
}: {
  propertyId: string;
  pricing: PropertyPricing | null;
  defaultCurrency: string;
}) {
  const { t } = useT();
  const [state, action] = useActionState(updatePricingAction, IDLE);

  const errorFor = (field: string): string | undefined => {
    const key = state.fieldErrors?.[field];
    return key ? t(key as TranslationKey) : undefined;
  };

  return (
    <form action={action} className="space-y-4 border-t border-slate-100 p-5">
      <input type="hidden" name="propertyId" value={propertyId} />

      {state.status === 'error' && state.messageKey && !state.fieldErrors ? (
        <Alert tone="error">{t(state.messageKey)}</Alert>
      ) : null}
      {state.status === 'success' && state.messageKey ? (
        <Alert tone="success">{t(state.messageKey)}</Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="weekdayPrice" label={t('pricing.weekday')} error={errorFor('weekdayPrice')}>
          <TextInput
            id="weekdayPrice"
            name="weekdayPrice"
            type="number"
            min={0}
            step="0.01"
            required
            inputMode="decimal"
            defaultValue={pricing?.weekday_price ?? '0'}
            invalid={Boolean(errorFor('weekdayPrice'))}
          />
        </Field>
        <Field id="weekendPrice" label={t('pricing.weekend')} error={errorFor('weekendPrice')}>
          <TextInput
            id="weekendPrice"
            name="weekendPrice"
            type="number"
            min={0}
            step="0.01"
            required
            inputMode="decimal"
            defaultValue={pricing?.weekend_price ?? '0'}
            invalid={Boolean(errorFor('weekendPrice'))}
          />
        </Field>
        <Field id="pricingCurrency" label={t('pricing.currency')} error={errorFor('currency')}>
          <SelectInput
            id="pricingCurrency"
            name="currency"
            defaultValue={pricing?.currency ?? defaultCurrency}
          >
            {CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>

      <SubmitButton labelKey="common.save" />
    </form>
  );
}
