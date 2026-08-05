'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import {
  BOOKING_SOURCES,
  formatMoney,
  isOverridable,
  priceBooking,
  statusLabel,
  utcToZonedInput,
  zonedTimeToUtc,
} from '@homestay/shared';
import type {
  BookingStatus,
  BookingWithDetails,
  Customer,
  Locale,
  Property,
  PropertyPricing,
  TranslationKey,
} from '@homestay/shared';
import { saveBookingAction, type BookingActionState } from '@/lib/actions/bookings';
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

/** Enough to name the property and preview the price; a `PropertyWithDetails` fits. */
export type PropertyOption = Pick<Property, 'id' | 'name'> & {
  pricing?: PropertyPricing | null;
};

/**
 * One form for creating and editing. The price shown is a preview computed by
 * the same `priceBooking()` the mobile app uses; the database recomputes it on
 * save, so this number never decides what is stored.
 */
export function BookingForm({
  booking,
  properties,
  customers,
  statuses,
  timezone,
  locale,
  canOverridePrice,
  canOverrideConflict,
}: {
  booking?: BookingWithDetails;
  properties: PropertyOption[];
  customers: Pick<Customer, 'id' | 'full_name' | 'phone'>[];
  statuses: BookingStatus[];
  timezone: string;
  locale: Locale;
  canOverridePrice: boolean;
  canOverrideConflict: boolean;
}) {
  const { t } = useT();
  const [state, action] = useActionState<BookingActionState, FormData>(saveBookingAction, IDLE);

  const [propertyId, setPropertyId] = useState(booking?.property_id ?? properties[0]?.id ?? '');
  const [checkInAt, setCheckInAt] = useState(
    booking ? utcToZonedInput(booking.check_in_at, timezone) : '',
  );
  const [checkOutAt, setCheckOutAt] = useState(
    booking ? utcToZonedInput(booking.check_out_at, timezone) : '',
  );
  const [newCustomer, setNewCustomer] = useState(false);
  const [overridePrice, setOverridePrice] = useState(booking?.price_overridden ?? false);

  const property = properties.find((row) => row.id === propertyId);
  const preview =
    property?.pricing && checkInAt && checkOutAt && checkOutAt > checkInAt
      ? // The inputs are wall-clock in the business zone; the server reads them
        // exactly the same way before pricing the stay.
        priceBooking(
          property.pricing,
          zonedTimeToUtc(checkInAt, timezone),
          zonedTimeToUtc(checkOutAt, timezone),
          timezone,
        )
      : null;

  const errorFor = (field: string): string | undefined => {
    const key = state.fieldErrors?.[field];
    return key ? t(key as TranslationKey) : undefined;
  };

  const conflicts = state.conflicts ?? [];
  const overridable = isOverridable(conflicts) && canOverrideConflict;
  // Changing the dates under a manual price is the one edit that silently
  // changes what a guest owes, so it is called out rather than recalculated.
  const priceWarning = booking?.price_overridden && !overridePrice;

  return (
    <form action={action} className="max-w-2xl space-y-6">
      {/* A duplicate arrives as a booking with no id: it seeds the form, but it
          saves as a new booking. */}
      {booking?.id ? <input type="hidden" name="bookingId" value={booking.id} /> : null}

      {state.status === 'error' && state.messageKey && conflicts.length === 0 ? (
        <Alert tone="error">{t(state.messageKey)}</Alert>
      ) : null}

      {conflicts.length > 0 ? (
        <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <p className="font-medium">{t('booking.conflict.title')}</p>
          <p className="mt-1">{t('booking.conflict.body')}</p>
          <ul className="mt-2 space-y-1">
            {conflicts.map((conflict) => (
              <li key={conflict.id}>
                {conflict.kind === 'booking'
                  ? t('availability.conflict.booking', { number: conflict.label })
                  : conflict.label}
                {conflict.starts_at && conflict.ends_at
                  ? ` — ${t('booking.conflict.range', {
                      start: utcToZonedInput(conflict.starts_at, timezone).replace('T', ' '),
                      end: utcToZonedInput(conflict.ends_at, timezone).replace('T', ' '),
                    })}`
                  : null}
              </li>
            ))}
          </ul>

          {overridable ? (
            <div className="mt-3 space-y-2 border-t border-amber-200 pt-3">
              <Checkbox
                id="conflictOverride"
                name="conflictOverride"
                label={t('booking.conflict.override')}
                defaultChecked
              />
              <Field
                id="conflictOverrideReason"
                label={t('booking.conflict.reason')}
                error={errorFor('conflictOverrideReason')}
              >
                <TextInput
                  id="conflictOverrideReason"
                  name="conflictOverrideReason"
                  required
                  minLength={3}
                  maxLength={300}
                  invalid={Boolean(errorFor('conflictOverrideReason'))}
                />
              </Field>
            </div>
          ) : (
            <p className="mt-2 font-medium">
              {isOverridable(conflicts)
                ? t('booking.conflict.forbidden')
                : t('booking.error.propertyUnavailable')}
            </p>
          )}
        </div>
      ) : null}

      <Panel className="space-y-4 p-5">
        <Field id="propertyId" label={t('booking.property')} error={errorFor('propertyId')}>
          <SelectInput
            id="propertyId"
            name="propertyId"
            required
            value={propertyId}
            onChange={(event) => setPropertyId(event.target.value)}
            invalid={Boolean(errorFor('propertyId'))}
          >
            <option value="">{t('common.notSet')}</option>
            {properties.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </SelectInput>
        </Field>

        {newCustomer ? (
          <>
            <input type="hidden" name="customerId" value="" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="newCustomerName"
                label={t('booking.customer.name')}
                error={errorFor('newCustomerName')}
              >
                <TextInput
                  id="newCustomerName"
                  name="newCustomerName"
                  required
                  maxLength={160}
                  invalid={Boolean(errorFor('newCustomerName'))}
                />
              </Field>
              <Field
                id="newCustomerPhone"
                label={t('booking.customer.phone')}
                error={errorFor('newCustomerPhone')}
              >
                <TextInput
                  id="newCustomerPhone"
                  name="newCustomerPhone"
                  type="tel"
                  required
                  inputMode="tel"
                  placeholder="012 345 678"
                  invalid={Boolean(errorFor('newCustomerPhone'))}
                />
              </Field>
            </div>
            <button
              type="button"
              onClick={() => setNewCustomer(false)}
              className="text-sm font-medium text-brand-800 underline"
            >
              {t('booking.customer.existing')}
            </button>
          </>
        ) : (
          <>
            <Field id="customerId" label={t('booking.customer')} error={errorFor('customerId')}>
              <SelectInput
                id="customerId"
                name="customerId"
                required
                defaultValue={booking?.customer_id ?? ''}
                invalid={Boolean(errorFor('customerId'))}
              >
                <option value="">{t('common.notSet')}</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.full_name} — {customer.phone}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <button
              type="button"
              onClick={() => setNewCustomer(true)}
              className="text-sm font-medium text-brand-800 underline"
            >
              {t('booking.customer.new')}
            </button>
          </>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="checkInAt" label={t('booking.checkIn')} error={errorFor('checkInAt')}>
            <TextInput
              id="checkInAt"
              name="checkInAt"
              type="datetime-local"
              required
              value={checkInAt}
              onChange={(event) => setCheckInAt(event.target.value)}
              invalid={Boolean(errorFor('checkInAt'))}
            />
          </Field>
          <Field id="checkOutAt" label={t('booking.checkOut')} error={errorFor('checkOutAt')}>
            <TextInput
              id="checkOutAt"
              name="checkOutAt"
              type="datetime-local"
              required
              value={checkOutAt}
              onChange={(event) => setCheckOutAt(event.target.value)}
              invalid={Boolean(errorFor('checkOutAt'))}
            />
          </Field>
        </div>

        {preview ? (
          <div className="rounded-sm border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
            <p className="font-medium text-slate-900">
              {t('booking.price.calculated')}:{' '}
              {formatMoney(locale, preview.total, preview.currency)}
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

        {priceWarning ? <Alert tone="info">{t('booking.price.override.warning')}</Alert> : null}
      </Panel>

      <Panel className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="statusId" label={t('booking.status')} error={errorFor('statusId')}>
            <SelectInput id="statusId" name="statusId" defaultValue={booking?.status_id ?? ''}>
              <option value="">{t('booking.status.pending')}</option>
              {statuses.map((status) => (
                <option key={status.id} value={status.id}>
                  {statusLabel(status, t)}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field id="source" label={t('booking.source')} error={errorFor('source')}>
            <SelectInput id="source" name="source" defaultValue={booking?.source ?? 'other'}>
              {BOOKING_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {t(`booking.source.${source}` as TranslationKey)}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>

        {canOverridePrice ? (
          <>
            <Checkbox
              id="overridePrice"
              label={t('booking.price.override')}
              checked={overridePrice}
              onChange={(event) => setOverridePrice(event.target.checked)}
            />
            {overridePrice ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id="finalPrice"
                  label={t('booking.price.final')}
                  error={errorFor('finalPrice')}
                >
                  <TextInput
                    id="finalPrice"
                    name="finalPrice"
                    type="number"
                    min={0}
                    step="0.01"
                    required
                    defaultValue={booking?.price_overridden ? String(booking.final_price) : ''}
                    invalid={Boolean(errorFor('finalPrice'))}
                  />
                </Field>
                <Field
                  id="priceOverrideReason"
                  label={t('booking.price.override.reason')}
                  error={errorFor('priceOverrideReason')}
                >
                  <TextInput
                    id="priceOverrideReason"
                    name="priceOverrideReason"
                    required
                    minLength={3}
                    maxLength={300}
                    defaultValue={booking?.price_override_reason ?? ''}
                    invalid={Boolean(errorFor('priceOverrideReason'))}
                  />
                </Field>
              </div>
            ) : null}
          </>
        ) : null}
      </Panel>

      <Panel className="space-y-4 p-5">
        <Field id="note" label={t('booking.note')} error={errorFor('note')}>
          <TextArea id="note" name="note" maxLength={2000} defaultValue={booking?.note ?? ''} />
        </Field>
        <Field
          id="internalNote"
          label={t('booking.internalNote')}
          hint={t('booking.internalNote.hint')}
          error={errorFor('internalNote')}
        >
          <TextArea
            id="internalNote"
            name="internalNote"
            maxLength={2000}
            defaultValue={booking?.internal_note ?? ''}
          />
        </Field>
      </Panel>

      <div className="flex items-center gap-3">
        <SubmitButton labelKey={booking?.id ? 'common.save' : 'booking.new'} />
        <Link
          href={booking?.id ? `/bookings/${booking.id}` : '/bookings'}
          className={buttonStyles('secondary')}
        >
          {t('common.cancel')}
        </Link>
      </div>
    </form>
  );
}
