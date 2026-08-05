'use client';

import { useActionState } from 'react';
import {
  BLOCK_REASONS,
  formatDateTime,
  type PropertyBlock,
  type TranslationKey,
} from '@homestay/shared';
import { cancelBlockAction, createBlockAction } from '@/lib/actions/properties';
import { IDLE } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { SubmitButton } from '@/components/SubmitButton';
import { Alert, Badge, Button, Field, SelectInput, TextInput } from '@/components/ui';

export function BlockManager({
  propertyId,
  blocks,
  timezone,
  canManage,
}: {
  propertyId: string;
  blocks: PropertyBlock[];
  timezone: string;
  canManage: boolean;
}) {
  const { locale, t } = useT();
  const [state, action] = useActionState(createBlockAction, IDLE);

  const errorFor = (field: string): string | undefined => {
    const key = state.fieldErrors?.[field];
    return key ? t(key as TranslationKey) : undefined;
  };

  return (
    <div className="space-y-5 border-t border-slate-100 p-5">
      {canManage ? (
        <form action={action} className="space-y-4">
          <input type="hidden" name="propertyId" value={propertyId} />

          {state.status === 'error' && state.messageKey && !state.fieldErrors ? (
            <Alert tone="error">{t(state.messageKey)}</Alert>
          ) : null}
          {state.status === 'success' && state.messageKey ? (
            <Alert tone="success">{t(state.messageKey)}</Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="startsAt" label={t('block.field.start')} error={errorFor('startsAt')}>
              <TextInput
                id="startsAt"
                name="startsAt"
                type="datetime-local"
                required
                invalid={Boolean(errorFor('startsAt'))}
              />
            </Field>
            <Field id="endsAt" label={t('block.field.end')} error={errorFor('endsAt')}>
              <TextInput
                id="endsAt"
                name="endsAt"
                type="datetime-local"
                required
                invalid={Boolean(errorFor('endsAt'))}
              />
            </Field>
            <Field id="reason" label={t('block.field.reason')} error={errorFor('reason')}>
              <SelectInput id="reason" name="reason" defaultValue="maintenance">
                {BLOCK_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {t(`block.reason.${reason}` as TranslationKey)}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field id="note" label={t('block.field.note')} error={errorFor('note')}>
              <TextInput
                id="note"
                name="note"
                maxLength={500}
                invalid={Boolean(errorFor('note'))}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton labelKey="block.new" variant="secondary" />
            <p className="text-xs text-slate-500">{t('block.timezoneNote', { timezone })}</p>
          </div>
        </form>
      ) : null}

      {blocks.length === 0 ? (
        <p className="text-sm text-slate-600">{t('block.empty')}</p>
      ) : (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {blocks.map((block) => (
            <li key={block.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">
                  {formatDateTime(locale, block.starts_at, timezone)} –{' '}
                  {formatDateTime(locale, block.ends_at, timezone)}
                </p>
                <p className="mt-0.5 text-sm text-slate-600">
                  {t(`block.reason.${block.reason}` as TranslationKey)}
                  {block.note ? ` — ${block.note}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {block.status === 'cancelled' ? (
                  <span className="text-xs text-slate-500">{t('block.status.cancelled')}</span>
                ) : (
                  <Badge>{t('block.status.active')}</Badge>
                )}
                {canManage && block.status === 'active' ? (
                  <form action={cancelBlockAction}>
                    <input type="hidden" name="blockId" value={block.id} />
                    <input type="hidden" name="propertyId" value={propertyId} />
                    <Button
                      type="submit"
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      onClick={(event) => {
                        if (!window.confirm(t('block.cancelConfirm'))) event.preventDefault();
                      }}
                    >
                      {t('block.cancel')}
                    </Button>
                  </form>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
