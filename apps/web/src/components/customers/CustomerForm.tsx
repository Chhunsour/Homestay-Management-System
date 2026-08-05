'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import type { Customer, TranslationKey } from '@homestay/shared';
import {
  createCustomerAction,
  updateCustomerAction,
  type CustomerActionState,
} from '@/lib/actions/customers';
import { IDLE } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { SubmitButton } from '@/components/SubmitButton';
import {
  Alert,
  Field,
  Panel,
  SelectInput,
  TextArea,
  TextInput,
  buttonStyles,
} from '@/components/ui';

/**
 * Create and edit share one form. Only a name and a phone are required —
 * everything else is what staff fill in later, once the guest has actually
 * stayed. A form that demands more than that gets filled with junk.
 */
export function CustomerForm({
  customer,
  defaultLanguage,
}: {
  customer?: Customer;
  defaultLanguage: string;
}) {
  const { t } = useT();
  const editing = Boolean(customer);
  const [state, action] = useActionState<CustomerActionState, FormData>(
    editing ? updateCustomerAction : createCustomerAction,
    IDLE,
  );

  const errorFor = (field: string): string | undefined => {
    const key = state.fieldErrors?.[field];
    return key ? t(key as TranslationKey) : undefined;
  };

  return (
    <form action={action} className="max-w-2xl space-y-6">
      {customer ? <input type="hidden" name="customerId" value={customer.id} /> : null}

      {/* The duplicate warning is the one error that offers a way out. */}
      {state.duplicate ? (
        <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <p className="font-medium">{t('customer.duplicate.title')}</p>
          <p className="mt-1">
            {t('customer.duplicate.body', {
              name: state.duplicate.name,
              phone: state.duplicate.phone,
            })}
          </p>
          <Link
            href={`/guests/${state.duplicate.id}`}
            className="mt-2 inline-block font-medium underline"
          >
            {t('customer.duplicate.open')}
          </Link>
        </div>
      ) : null}

      {state.status === 'error' && state.messageKey && !state.fieldErrors && !state.duplicate ? (
        <Alert tone="error">{t(state.messageKey)}</Alert>
      ) : null}
      {state.status === 'success' && state.messageKey ? (
        <Alert tone="success">{t(state.messageKey)}</Alert>
      ) : null}

      <Panel className="space-y-4 p-5">
        <h2 className="text-sm font-semibold text-slate-900">{t('customer.section.contact')}</h2>

        <Field id="fullName" label={t('customer.field.fullName')} error={errorFor('fullName')}>
          <TextInput
            id="fullName"
            name="fullName"
            required
            maxLength={160}
            autoComplete="off"
            defaultValue={customer?.full_name ?? ''}
            invalid={Boolean(errorFor('fullName'))}
          />
        </Field>

        <Field
          id="phone"
          label={t('customer.field.phone')}
          hint={t('customer.field.phone.hint')}
          error={errorFor('phone')}
        >
          <TextInput
            id="phone"
            name="phone"
            type="tel"
            required
            maxLength={32}
            inputMode="tel"
            placeholder="012 345 678"
            defaultValue={customer?.phone ?? ''}
            invalid={Boolean(errorFor('phone'))}
          />
        </Field>

        <Field
          id="phoneSecondary"
          label={t('customer.field.phoneSecondary')}
          error={errorFor('phoneSecondary')}
        >
          <TextInput
            id="phoneSecondary"
            name="phoneSecondary"
            type="tel"
            maxLength={32}
            inputMode="tel"
            defaultValue={customer?.phone_secondary ?? ''}
            invalid={Boolean(errorFor('phoneSecondary'))}
          />
        </Field>

        <Field id="email" label={t('customer.field.email')} error={errorFor('email')}>
          <TextInput
            id="email"
            name="email"
            type="email"
            maxLength={320}
            defaultValue={customer?.email ?? ''}
            invalid={Boolean(errorFor('email'))}
          />
        </Field>
      </Panel>

      <Panel className="space-y-4 p-5">
        <h2 className="text-sm font-semibold text-slate-900">{t('customer.section.details')}</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="facebookName"
            label={t('customer.field.facebookName')}
            error={errorFor('facebookName')}
          >
            <TextInput
              id="facebookName"
              name="facebookName"
              maxLength={160}
              defaultValue={customer?.facebook_name ?? ''}
              invalid={Boolean(errorFor('facebookName'))}
            />
          </Field>
          <Field
            id="telegramUsername"
            label={t('customer.field.telegram')}
            error={errorFor('telegramUsername')}
          >
            <TextInput
              id="telegramUsername"
              name="telegramUsername"
              maxLength={64}
              placeholder="@username"
              defaultValue={customer?.telegram_username ?? ''}
              invalid={Boolean(errorFor('telegramUsername'))}
            />
          </Field>
        </div>

        <Field
          id="facebookUrl"
          label={t('customer.field.facebookUrl')}
          error={errorFor('facebookUrl')}
        >
          <TextInput
            id="facebookUrl"
            name="facebookUrl"
            maxLength={500}
            defaultValue={customer?.facebook_url ?? ''}
            invalid={Boolean(errorFor('facebookUrl'))}
          />
        </Field>

        <Field
          id="preferredLanguage"
          label={t('customer.field.language')}
          error={errorFor('preferredLanguage')}
        >
          <SelectInput
            id="preferredLanguage"
            name="preferredLanguage"
            defaultValue={customer?.preferred_language ?? defaultLanguage}
          >
            <option value="en">{t('common.english')}</option>
            <option value="km">{t('common.khmer')}</option>
          </SelectInput>
        </Field>

        <Field id="address" label={t('customer.field.address')} error={errorFor('address')}>
          <TextInput
            id="address"
            name="address"
            maxLength={500}
            defaultValue={customer?.address ?? ''}
            invalid={Boolean(errorFor('address'))}
          />
        </Field>

        <Field id="note" label={t('customer.field.note')} error={errorFor('note')}>
          <TextArea
            id="note"
            name="note"
            maxLength={2000}
            defaultValue={customer?.note ?? ''}
            invalid={Boolean(errorFor('note'))}
          />
        </Field>
      </Panel>

      <div className="flex items-center gap-3">
        <SubmitButton labelKey={editing ? 'common.save' : 'customer.create.submit'} />
        <Link
          href={customer ? `/guests/${customer.id}` : '/guests'}
          className={buttonStyles('secondary')}
        >
          {t('common.cancel')}
        </Link>
      </div>
    </form>
  );
}
