'use client';

import { useActionState } from 'react';
import { findStatusByCode, isOverridable, statusLabel } from '@homestay/shared';
import type { BookingStatus, BookingWithDetails } from '@homestay/shared';
import {
  resolvePendingAction,
  setBookingStatusAction,
  type BookingActionState,
} from '@/lib/actions/bookings';
import { IDLE } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { SubmitButton } from '@/components/SubmitButton';
import { Alert, Button, Checkbox, Field, Panel, SelectInput, TextInput } from '@/components/ui';

/**
 * Status changes on the detail page: the select, plus the one-click shortcuts
 * for cancel, complete and reopen. All four are the same RPC — the buttons only
 * pre-pick the system status, and the database decides who may use them.
 */
export function BookingActions({
  booking,
  statuses,
  canCancel,
  canRestore,
  canResolvePending,
  expired,
}: {
  booking: BookingWithDetails;
  statuses: BookingStatus[];
  canCancel: boolean;
  canRestore: boolean;
  canResolvePending: boolean;
  expired: boolean;
}) {
  const { t } = useT();
  const [state, action] = useActionState<BookingActionState, FormData>(
    setBookingStatusAction,
    IDLE,
  );

  const cancelled = findStatusByCode(statuses, 'cancelled');
  const completed = findStatusByCode(statuses, 'completed');
  const pending = findStatusByCode(statuses, 'pending');
  const isCancelled = booking.status?.code === 'cancelled';
  const conflicts = state.conflicts ?? [];

  return (
    <Panel className="space-y-4 p-5">
      <h2 className="text-sm font-semibold text-slate-900">{t('booking.status')}</h2>

      {state.status === 'error' && state.messageKey && conflicts.length === 0 ? (
        <Alert tone="error">{t(state.messageKey)}</Alert>
      ) : null}
      {state.status === 'success' && state.messageKey ? (
        <Alert tone="success">{t(state.messageKey)}</Alert>
      ) : null}

      <form action={action} className="space-y-3">
        <input type="hidden" name="bookingId" value={booking.id} />

        <Field id="statusId" label={t('booking.status')}>
          <SelectInput id="statusId" name="statusId" defaultValue={booking.status_id}>
            {statuses.map((status) => (
              <option key={status.id} value={status.id}>
                {statusLabel(status, t)}
              </option>
            ))}
          </SelectInput>
        </Field>

        {/* Reopening onto dates somebody else took is the one status change that
            can clash, so the same override flow as the form appears here. */}
        {conflicts.length > 0 ? (
          <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
            <p className="font-medium">{t('booking.conflict.title')}</p>
            <ul className="mt-1 space-y-1">
              {conflicts.map((conflict) => (
                <li key={conflict.id}>
                  {conflict.kind === 'booking'
                    ? t('availability.conflict.booking', { number: conflict.label })
                    : conflict.label}
                </li>
              ))}
            </ul>
            {isOverridable(conflicts) ? (
              <div className="mt-3 space-y-2">
                <Checkbox
                  id="statusConflictOverride"
                  name="conflictOverride"
                  label={t('booking.conflict.override')}
                  defaultChecked
                />
                <Field id="conflictOverrideReason" label={t('booking.conflict.reason')}>
                  <TextInput
                    id="conflictOverrideReason"
                    name="conflictOverrideReason"
                    required
                    minLength={3}
                    maxLength={300}
                  />
                </Field>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton labelKey="common.save" />

          {completed && !isCancelled ? (
            <Button type="submit" name="statusId" value={completed.id} variant="secondary">
              {t('booking.complete')}
            </Button>
          ) : null}

          {cancelled && canCancel && !isCancelled ? (
            <Button
              type="submit"
              name="statusId"
              value={cancelled.id}
              variant="secondary"
              // The dates go back on the market; worth one confirmation.
              onClick={(event) => {
                if (!confirm(t('booking.cancel.confirm'))) event.preventDefault();
              }}
            >
              {t('booking.cancel')}
            </Button>
          ) : null}

          {pending && canRestore && isCancelled ? (
            <Button type="submit" name="statusId" value={pending.id} variant="secondary">
              {t('booking.restore')}
            </Button>
          ) : null}
        </div>
      </form>

      {expired && canResolvePending ? (
        <div className="space-y-2 border-t border-slate-100 pt-4">
          <p className="text-sm font-medium text-slate-900">{t('booking.pending.review.title')}</p>
          <p className="text-sm text-slate-600">{t('booking.pending.review.body')}</p>
          <form action={resolvePendingAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="bookingId" value={booking.id} />
            <Button type="submit" name="action" value="keep" variant="secondary">
              {t('booking.pending.keep')}
            </Button>
            <Button type="submit" name="action" value="release" variant="secondary">
              {t('booking.pending.release')}
            </Button>
          </form>
        </div>
      ) : null}
    </Panel>
  );
}
