import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { customerNoteSchema, fieldErrors, formatDateTime } from '@homestay/shared';
import type { CustomerNote, TranslationKey } from '@homestay/shared';
import { Banner, Button, Empty, Field, colors } from '@/components/ui';
import { useSession } from '@/lib/session';
import { addCustomerNote, archiveCustomerNote } from '@/lib/customers';

/**
 * Internal notes. Staff only — customers never sign in and nothing here is ever
 * rendered anywhere a guest could see it.
 *
 * ponytail: notes show a timestamp but no author name; the app has no member
 * directory yet. Add one when the members screen lands.
 */
export function CustomerNotes({
  customerId,
  notes,
  canAdd,
  canRemove,
  onChanged,
}: {
  customerId: string;
  notes: CustomerNote[];
  canAdd: boolean;
  canRemove: boolean;
  onChanged: () => void;
}) {
  const { t, locale, business } = useSession();

  const [body, setBody] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(): Promise<void> {
    if (!business) return;
    setError(undefined);
    setErrorKey(null);

    const parsed = customerNoteSchema.safeParse({ customerId, body });
    if (!parsed.success) {
      const failed = fieldErrors(parsed.error);
      return setError(failed.body ? t(failed.body as TranslationKey) : undefined);
    }

    setBusy(true);
    try {
      const failed = await addCustomerNote(business.business_id, customerId, parsed.data.body);
      if (failed) return setErrorKey(failed);
      setBody('');
      onChanged();
    } catch {
      setErrorKey('error.network');
    } finally {
      setBusy(false);
    }
  }

  function confirmRemove(noteId: string): void {
    if (!business) return;
    Alert.alert(t('customer.notes.remove'), t('customer.notes.removeConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('customer.notes.remove'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const failed = await archiveCustomerNote(business.business_id, noteId);
            if (failed) setErrorKey(failed);
            else onChanged();
          })();
        },
      },
    ]);
  }

  return (
    <>
      {errorKey ? <Banner tone="error">{t(errorKey)}</Banner> : null}

      {canAdd ? (
        <>
          <Field
            label={t('customer.notes.add')}
            value={body}
            onChangeText={setBody}
            error={error}
            placeholder={t('customer.notes.placeholder')}
            multiline
            numberOfLines={3}
            maxLength={2000}
          />
          <Button
            label={t('customer.notes.add')}
            variant="secondary"
            loading={busy}
            onPress={() => void add()}
          />
        </>
      ) : null}

      {notes.length === 0 ? (
        <Empty title={t('customer.notes.empty')} body={t('customer.notes.subtitle')} />
      ) : (
        notes.map((note) => (
          <View key={note.id} style={styles.note}>
            <Text style={styles.body}>{note.body}</Text>
            <Text style={styles.meta}>
              {formatDateTime(locale, note.created_at, business?.timezone)}
            </Text>
            {canRemove ? (
              <Button
                label={t('customer.notes.remove')}
                variant="ghost"
                onPress={() => confirmRemove(note.id)}
              />
            ) : null}
          </View>
        ))
      )}
    </>
  );
}

const styles = StyleSheet.create({
  note: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 7,
  },
  body: { fontSize: 14, lineHeight: 21, color: colors.text },
  meta: { fontSize: 12, color: colors.muted },
});
