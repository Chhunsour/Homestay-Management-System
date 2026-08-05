'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import {
  CURRENCIES,
  toTimeInput,
  type PropertyWithDetails,
  type TranslationKey,
} from '@homestay/shared';
import { createPropertyAction, updatePropertyAction } from '@/lib/actions/properties';
import { IDLE } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { SubmitButton } from '@/components/SubmitButton';
import {
  Alert,
  Checkbox,
  Field,
  Panel,
  SelectInput,
  TextArea,
  TextInput,
  buttonStyles,
} from '@/components/ui';

/**
 * Create and edit share one form. On create it also collects the base rate,
 * because `create_property` writes the property and its pricing together.
 */
export function PropertyForm({
  property,
  defaultCurrency,
}: {
  property?: PropertyWithDetails;
  defaultCurrency: string;
}) {
  const { t } = useT();
  const editing = Boolean(property);
  const [state, action] = useActionState(
    editing ? updatePropertyAction : createPropertyAction,
    IDLE,
  );

  const errorFor = (field: string): string | undefined => {
    const key = state.fieldErrors?.[field];
    return key ? t(key as TranslationKey) : undefined;
  };

  return (
    <form action={action} className="max-w-2xl space-y-6">
      {property ? <input type="hidden" name="propertyId" value={property.id} /> : null}

      {state.status === 'error' && state.messageKey && !state.fieldErrors ? (
        <Alert tone="error">{t(state.messageKey)}</Alert>
      ) : null}
      {state.status === 'success' && state.messageKey ? (
        <Alert tone="success">{t(state.messageKey)}</Alert>
      ) : null}

      <Panel className="space-y-4 p-5">
        <h2 className="text-sm font-semibold text-slate-900">{t('property.section.details')}</h2>

        <Field id="name" label={t('property.field.name')} error={errorFor('name')}>
          <TextInput
            id="name"
            name="name"
            required
            maxLength={120}
            defaultValue={property?.name ?? ''}
            invalid={Boolean(errorFor('name'))}
          />
        </Field>

        <Field
          id="description"
          label={t('property.field.description')}
          error={errorFor('description')}
        >
          <TextArea
            id="description"
            name="description"
            maxLength={4000}
            defaultValue={property?.description ?? ''}
            invalid={Boolean(errorFor('description'))}
          />
        </Field>

        <Field
          id="phone"
          label={t('property.field.phone')}
          hint={t('validation.phone')}
          error={errorFor('phone')}
        >
          <TextInput
            id="phone"
            name="phone"
            type="tel"
            placeholder="+85512345678"
            defaultValue={property?.phone ?? ''}
            invalid={Boolean(errorFor('phone'))}
          />
        </Field>

        <Checkbox
          id="isActive"
          name="isActive"
          label={t('property.field.active')}
          hint={t('property.field.active.hint')}
          defaultChecked={property ? property.is_active : true}
        />
      </Panel>

      <Panel className="space-y-4 p-5">
        <h2 className="text-sm font-semibold text-slate-900">{t('property.section.location')}</h2>

        <Field id="address" label={t('property.field.address')} error={errorFor('address')}>
          <TextInput
            id="address"
            name="address"
            maxLength={500}
            defaultValue={property?.address ?? ''}
            invalid={Boolean(errorFor('address'))}
          />
        </Field>

        <Field
          id="mapLocation"
          label={t('property.field.mapLocation')}
          hint={t('property.field.mapLocation.hint')}
          error={errorFor('mapLocation')}
        >
          <TextInput
            id="mapLocation"
            name="mapLocation"
            maxLength={500}
            defaultValue={property?.map_location ?? ''}
            invalid={Boolean(errorFor('mapLocation'))}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="latitude"
            label={t('property.field.latitude')}
            hint={t('property.field.coordinates.hint')}
            error={errorFor('latitude')}
          >
            <TextInput
              id="latitude"
              name="latitude"
              type="number"
              step="0.000001"
              min={-90}
              max={90}
              inputMode="decimal"
              defaultValue={property?.latitude ?? ''}
              invalid={Boolean(errorFor('latitude'))}
            />
          </Field>
          <Field id="longitude" label={t('property.field.longitude')} error={errorFor('longitude')}>
            <TextInput
              id="longitude"
              name="longitude"
              type="number"
              step="0.000001"
              min={-180}
              max={180}
              inputMode="decimal"
              defaultValue={property?.longitude ?? ''}
              invalid={Boolean(errorFor('longitude'))}
            />
          </Field>
        </div>
      </Panel>

      <Panel className="space-y-4 p-5">
        <h2 className="text-sm font-semibold text-slate-900">{t('property.section.times')}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="checkInTime"
            label={t('property.field.checkIn')}
            error={errorFor('checkInTime')}
          >
            <TextInput
              id="checkInTime"
              name="checkInTime"
              type="time"
              required
              defaultValue={toTimeInput(property?.default_check_in_time) || '14:00'}
              invalid={Boolean(errorFor('checkInTime'))}
            />
          </Field>
          <Field
            id="checkOutTime"
            label={t('property.field.checkOut')}
            error={errorFor('checkOutTime')}
          >
            <TextInput
              id="checkOutTime"
              name="checkOutTime"
              type="time"
              required
              defaultValue={toTimeInput(property?.default_check_out_time) || '12:00'}
              invalid={Boolean(errorFor('checkOutTime'))}
            />
          </Field>
        </div>
      </Panel>

      {/* Pricing is edited in its own section once the property exists. */}
      {editing ? null : (
        <Panel className="space-y-4 p-5">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">{t('pricing.title')}</h2>
            <p className="mt-1 text-sm text-slate-600">{t('pricing.subtitle')}</p>
          </div>
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
                defaultValue="0"
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
                defaultValue="0"
                invalid={Boolean(errorFor('weekendPrice'))}
              />
            </Field>
            <Field id="currency" label={t('pricing.currency')} error={errorFor('currency')}>
              <SelectInput id="currency" name="currency" defaultValue={defaultCurrency}>
                {CURRENCIES.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
        </Panel>
      )}

      <div className="flex items-center gap-3">
        <SubmitButton labelKey={editing ? 'common.save' : 'property.create.submit'} />
        <Link
          href={property ? `/properties/${property.id}` : '/properties'}
          className={buttonStyles('secondary')}
        >
          {t('common.cancel')}
        </Link>
      </div>
    </form>
  );
}
