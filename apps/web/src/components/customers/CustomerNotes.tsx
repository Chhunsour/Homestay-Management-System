'use client';

import { useActionState } from 'react';
import { formatDateTime, type CustomerNote, type TranslationKey } from '@homestay/shared';
import { addCustomerNoteAction, archiveCustomerNoteAction } from '@/lib/actions/customers';
import { IDLE } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { SubmitButton } from '@/components/SubmitButton';
import { Alert, Button, TextArea } from '@/components/ui';

/**
 * Internal notes. Anyone who can open the customer can add one; only owners and
 * managers can take one away, and "away" means archived — there is no DELETE
 * grant on the table.
 */
export function CustomerNotes({
  customerId,
  notes,
  authors,
  timezone,
  canAdd,
  canRemove,
}: {
  customerId: string;
  notes: CustomerNote[];
  /** user id -> display name, for the notes we can attribute. */
  authors: Record<string, string>;
  timezone: string;
  canAdd: boolean;
  canRemove: boolean;
}) {
  const { t, locale } = useT();
  const [state, action] = useActionState(addCustomerNoteAction, IDLE);
  const bodyError = state.fieldErrors?.body;

  return (
    <div className="border-t border-slate-100">
      {canAdd ? (
        <form action={action} className="space-y-3 px-5 py-4">
          <input type="hidden" name="customerId" value={customerId} />
          <label htmlFor="body" className="sr-only">
            {t('customer.notes.add')}
          </label>
          <TextArea
            id="body"
            name="body"
            required
            maxLength={2000}
            placeholder={t('customer.notes.placeholder')}
            invalid={Boolean(bodyError)}
          />
          {bodyError ? <Alert tone="error">{t(bodyError as TranslationKey)}</Alert> : null}
          {state.status === 'success' && state.messageKey ? (
            <Alert tone="success">{t(state.messageKey)}</Alert>
          ) : null}
          {state.status === 'error' && state.messageKey && !bodyError ? (
            <Alert tone="error">{t(state.messageKey)}</Alert>
          ) : null}
          <SubmitButton labelKey="customer.notes.add" variant="secondary" />
        </form>
      ) : null}

      {notes.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-slate-600">{t('customer.notes.empty')}</p>
      ) : (
        <ul className="border-t border-slate-100">
          {notes.map((note) => (
            <li
              key={note.id}
              className="flex gap-3 border-b border-slate-100 px-5 py-4 last:border-b-0"
            >
              <div className="flex-1">
                <p className="text-sm whitespace-pre-wrap text-slate-900">{note.body}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {[
                    note.created_by ? authors[note.created_by] : null,
                    formatDateTime(locale, note.created_at, timezone),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              {canRemove ? (
                <form action={archiveCustomerNoteAction}>
                  <input type="hidden" name="noteId" value={note.id} />
                  <input type="hidden" name="customerId" value={customerId} />
                  <Button
                    type="submit"
                    variant="ghost"
                    className="text-red-700 hover:bg-red-50"
                    onClick={(event) => {
                      if (!window.confirm(t('customer.notes.removeConfirm')))
                        event.preventDefault();
                    }}
                  >
                    {t('customer.notes.remove')}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
