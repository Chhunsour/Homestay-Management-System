'use client';

import { useState, useTransition, type ChangeEvent } from 'react';
import Link from 'next/link';
import {
  CUSTOMER_IMPORT_MAX_ROWS,
  duplicateRowIndexes,
  parseCustomerCsv,
  type TranslationKey,
} from '@homestay/shared';
import {
  importCustomersAction,
  reviewImportAction,
  type ImportPreviewRow,
  type ImportSummary,
} from '@/lib/actions/customers';
import { useT } from '@/components/LocaleProvider';
import { Alert, Button, Panel, buttonStyles } from '@/components/ui';

type RowStatus = 'valid' | 'duplicateFile' | 'duplicateDatabase' | 'invalid';

interface ReviewedRow extends ImportPreviewRow {
  status: RowStatus;
}

/**
 * Preview first, import second. Nothing reaches the database until the person
 * doing it has seen every row and what will happen to it — and each row that
 * does go in comes back with its own outcome, so nothing fails silently.
 */
export function ImportWizard() {
  const { t } = useT();
  const [pending, startTransition] = useTransition();
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [rows, setRows] = useState<ReviewedRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  async function onFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    setErrorKey(null);
    setSummary(null);
    setRows([]);
    setSelected(new Set());
    if (!file) return;

    const parsed = parseCustomerCsv(await file.text());
    if (parsed.fields.every((field) => field === null)) {
      setErrorKey('customer.import.noColumns');
      return;
    }
    if (parsed.rows.length === 0) {
      setErrorKey('customer.import.empty');
      return;
    }
    if (parsed.rows.length > CUSTOMER_IMPORT_MAX_ROWS) {
      setErrorKey('customer.import.tooMany');
      return;
    }

    // Repeats inside the file are found here; matches already in the database
    // need the server, which also re-validates every row.
    const repeated = duplicateRowIndexes(parsed.rows.map((row) => row.phone));
    const values = parsed.rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value ?? ''])),
    );

    startTransition(async () => {
      const review = await reviewImportAction(values);
      if (review.status === 'error') {
        setErrorKey((review.messageKey ?? 'error.generic') as TranslationKey);
        return;
      }
      const reviewed: ReviewedRow[] = review.rows.map((row) => ({
        ...row,
        status: row.errorKey
          ? 'invalid'
          : repeated.has(row.index)
            ? 'duplicateFile'
            : row.duplicateInDatabase
              ? 'duplicateDatabase'
              : 'valid',
      }));
      setRows(reviewed);
      // Only clean rows are ticked; the rest stay visible and skippable.
      setSelected(
        new Set(reviewed.filter((row) => row.status === 'valid').map((row) => row.index)),
      );
    });
  }

  function toggle(index: number): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function onImport(): void {
    const chosen = rows.filter((row) => selected.has(row.index));
    startTransition(async () => {
      const result = await importCustomersAction(
        chosen.map((row) => row.values),
        rows.length - chosen.length,
      );
      setSummary(result);
      if (result.status === 'ok') {
        setRows([]);
        setSelected(new Set());
      }
    });
  }

  const STATUS_KEYS: Record<RowStatus, TranslationKey> = {
    valid: 'customer.import.status.valid',
    duplicateFile: 'customer.import.status.duplicateFile',
    duplicateDatabase: 'customer.import.status.duplicateDatabase',
    invalid: 'customer.import.status.invalid',
  };

  return (
    <div className="space-y-6">
      <Panel className="space-y-4 p-5">
        <div>
          <label htmlFor="file" className="block text-sm font-medium text-slate-800">
            {t('customer.import.file')}
          </label>
          <input
            id="file"
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            disabled={pending}
            className="mt-1.5 block w-full rounded-sm border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 file:mr-3 file:rounded-sm file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700"
          />
        </div>
        <a
          href="/customers-sample.csv"
          download
          className="text-sm font-medium text-brand-800 underline"
        >
          {t('customer.import.sample')}
        </a>
        {errorKey ? <Alert tone="error">{t(errorKey)}</Alert> : null}
        {pending ? <Alert tone="info">{t('common.loading')}</Alert> : null}
      </Panel>

      {summary ? (
        <Panel className="space-y-3 p-5">
          <Alert tone={summary.status === 'ok' ? 'success' : 'error'}>
            {t((summary.messageKey ?? 'error.generic') as TranslationKey)}
          </Alert>
          {summary.status === 'ok' ? (
            <p className="text-sm text-slate-700">
              {t('customer.import.summary', {
                imported: String(summary.imported),
                skipped: String(summary.skipped + summary.duplicate),
                failed: String(summary.invalid),
              })}
            </p>
          ) : null}
          <Link href="/guests" className={buttonStyles('secondary')}>
            {t('customer.title')}
          </Link>
        </Panel>
      ) : null}

      {rows.length > 0 ? (
        <Panel className="overflow-x-auto">
          <div className="px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('customer.import.preview')}</h2>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="border-y border-slate-200 text-xs uppercase text-slate-600">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">
                  {t('customer.import.skipped')}
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  {t('customer.field.fullName')}
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  {t('customer.field.phone')}
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  {t('customer.import.status.valid')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.index} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-5 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(row.index)}
                      onChange={() => toggle(row.index)}
                      disabled={row.status === 'invalid'}
                      aria-label={t('customer.import.row', { row: String(row.index + 1) })}
                      className="size-4 rounded-xs border-slate-300 text-brand-700 focus:ring-brand-600"
                    />
                  </td>
                  <td className="px-5 py-3 text-slate-900">{row.values.full_name || '—'}</td>
                  <td className="px-5 py-3 text-slate-700">{row.values.phone || '—'}</td>
                  <td className="px-5 py-3">
                    <span
                      className={
                        row.status === 'valid'
                          ? 'text-emerald-800'
                          : row.status === 'invalid'
                            ? 'text-red-700'
                            : 'text-amber-800'
                      }
                    >
                      {t(STATUS_KEYS[row.status])}
                      {row.errorKey ? ` · ${t(row.errorKey as TranslationKey)}` : ''}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center gap-3 border-t border-slate-100 px-5 py-4">
            <Button type="button" onClick={onImport} disabled={pending || selected.size === 0}>
              {t('customer.import.submit', { count: String(selected.size) })}
            </Button>
            <Link href="/guests" className={buttonStyles('secondary')}>
              {t('common.cancel')}
            </Link>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
