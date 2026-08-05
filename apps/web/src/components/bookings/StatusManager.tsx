'use client';

import { useActionState } from 'react';
import { BOOKING_STATUS_CODES, statusLabel } from '@homestay/shared';
import type { BookingStatus, TranslationKey } from '@homestay/shared';
import { saveBookingStatusAction } from '@/lib/actions/bookings';
import { IDLE, type ActionState } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { SubmitButton } from '@/components/SubmitButton';
import { Alert, Checkbox, Field, SelectInput, TextInput } from '@/components/ui';

/**
 * One row per status, each its own form. Renaming one status should not make the
 * others unsaved, and the seeded rows keep their behaviour code either way — the
 * update path never sends `code`, and a trigger refuses it if it did.
 */
function StatusRow({ status }: { status?: BookingStatus }) {
  const { t } = useT();
  const [state, action] = useActionState<ActionState, FormData>(saveBookingStatusAction, IDLE);

  return (
    <form action={action} className="border-b border-slate-100 px-5 py-4 last:border-b-0">
      {status ? <input type="hidden" name="statusId" value={status.id} /> : null}

      {state.status === 'error' && state.messageKey ? (
        <Alert tone="error">{t(state.messageKey)}</Alert>
      ) : null}
      {state.status === 'success' && state.messageKey ? (
        <Alert tone="success">{t(state.messageKey)}</Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field id={`name-${status?.id ?? 'new'}`} label={t('status.name')}>
          <TextInput
            id={`name-${status?.id ?? 'new'}`}
            name="name"
            required
            maxLength={40}
            defaultValue={status ? statusLabel(status, t) : ''}
          />
        </Field>

        {status ? (
          // Behaviour is fixed once a status exists: rules elsewhere read the code.
          <Field id={`code-${status.id}`} label={t('status.code')}>
            <input type="hidden" name="code" value={status.code} />
            <p id={`code-${status.id}`} className="px-1 py-2 text-sm text-slate-600">
              {t(`booking.status.${status.code}` as TranslationKey)}
              {status.is_system ? ` · ${t('status.system')}` : ''}
            </p>
          </Field>
        ) : (
          <Field id="code-new" label={t('status.code')} hint={t('status.code.hint')}>
            <SelectInput id="code-new" name="code" defaultValue="pending">
              {BOOKING_STATUS_CODES.map((code) => (
                <option key={code} value={code}>
                  {t(`booking.status.${code}` as TranslationKey)}
                </option>
              ))}
            </SelectInput>
          </Field>
        )}

        <Field id={`color-${status?.id ?? 'new'}`} label={t('status.color')}>
          {/* Native colour picker: no palette component to maintain. */}
          <input
            id={`color-${status?.id ?? 'new'}`}
            name="color"
            type="color"
            defaultValue={status?.color ?? '#334155'}
            className="h-9 w-16 rounded-sm border border-slate-300 bg-white p-1"
          />
        </Field>

        <Field id={`sortOrder-${status?.id ?? 'new'}`} label={t('status.order')}>
          <TextInput
            id={`sortOrder-${status?.id ?? 'new'}`}
            name="sortOrder"
            type="number"
            min={0}
            max={999}
            required
            defaultValue={String(status?.sort_order ?? 10)}
          />
        </Field>

        <div className="flex items-end gap-3">
          <Checkbox
            id={`isActive-${status?.id ?? 'new'}`}
            name="isActive"
            label={t('status.inUse')}
            defaultChecked={status ? status.is_active : true}
          />
          <SubmitButton labelKey={status ? 'common.save' : 'common.add'} />
        </div>
      </div>
    </form>
  );
}

export function StatusManager({ statuses }: { statuses: BookingStatus[] }) {
  return (
    <>
      {statuses.map((status) => (
        <StatusRow key={status.id} status={status} />
      ))}
      <StatusRow />
    </>
  );
}
