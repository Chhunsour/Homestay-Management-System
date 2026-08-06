'use client';

import { useActionState } from 'react';
import {
  CURRENCIES,
  DEFAULT_TIMEZONE,
  LOCALES,
  TIMEZONE_OPTIONS,
  type Locale,
  type TranslationKey,
} from '@homestay/shared';
import { createBusinessAction } from '@/lib/actions/business';
import { IDLE } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { SubmitButton } from '@/components/SubmitButton';
import { Alert, Field, SelectInput, TextInput } from '@/components/ui';

const LOCALE_LABELS: Record<Locale, TranslationKey> = {
  en: 'common.english',
  km: 'common.khmer',
};

export function OnboardingForm({ defaultName }: { defaultName: string }) {
  const { locale, t } = useT();
  const [state, action] = useActionState(createBusinessAction, IDLE);

  const errorFor = (field: string): string | undefined => {
    const key = state.fieldErrors?.[field];
    return key ? t(key as TranslationKey) : undefined;
  };

  return (
    <div className="panel p-6 sm:p-8">
      <div className="mb-7">
        <span aria-hidden="true" className="mb-4 block h-1 w-10 rounded-full bg-accent-500" />
        <h1 className="font-display text-3xl font-semibold tracking-tight text-slate-900">
          {t('onboarding.title')}
        </h1>
        <p className="mt-1 text-sm text-slate-600">{t('onboarding.subtitle')}</p>
      </div>

      <div className="space-y-4">
        {state.status === 'error' && state.messageKey && !state.fieldErrors ? (
          <Alert tone="error">{t(state.messageKey)}</Alert>
        ) : null}

        <form action={action} className="space-y-4">
          <Field id="name" label={t('onboarding.field.businessName')} error={errorFor('name')}>
            <TextInput id="name" name="name" required invalid={Boolean(errorFor('name'))} />
          </Field>

          <Field
            id="ownerName"
            label={t('onboarding.field.ownerName')}
            error={errorFor('ownerName')}
          >
            <TextInput
              id="ownerName"
              name="ownerName"
              autoComplete="name"
              defaultValue={defaultName}
              required
              invalid={Boolean(errorFor('ownerName'))}
            />
          </Field>

          <Field
            id="phone"
            label={t('onboarding.field.phone')}
            hint={t('validation.phone')}
            error={errorFor('phone')}
          >
            <TextInput
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              placeholder="+85512345678"
              required
              invalid={Boolean(errorFor('phone'))}
            />
          </Field>

          <Field id="language" label={t('onboarding.field.language')} error={errorFor('language')}>
            <SelectInput
              id="language"
              name="language"
              defaultValue={locale}
              invalid={Boolean(errorFor('language'))}
            >
              {LOCALES.map((option) => (
                <option key={option} value={option} lang={option}>
                  {t(LOCALE_LABELS[option])}
                </option>
              ))}
            </SelectInput>
          </Field>

          <Field id="currency" label={t('onboarding.field.currency')} error={errorFor('currency')}>
            <SelectInput
              id="currency"
              name="currency"
              defaultValue="USD"
              invalid={Boolean(errorFor('currency'))}
            >
              {CURRENCIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </SelectInput>
          </Field>

          <Field id="timezone" label={t('onboarding.field.timezone')} error={errorFor('timezone')}>
            <SelectInput
              id="timezone"
              name="timezone"
              defaultValue={DEFAULT_TIMEZONE}
              invalid={Boolean(errorFor('timezone'))}
            >
              {TIMEZONE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </SelectInput>
          </Field>

          <SubmitButton labelKey="onboarding.submit" className="w-full" />
        </form>
      </div>
    </div>
  );
}
