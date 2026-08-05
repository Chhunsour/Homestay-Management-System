import { normalizePhone } from './phone.ts';

/**
 * Customer helpers shared by both apps and the CSV importer: search, duplicate
 * detection and CSV reading/writing. Business rules live here so the web and
 * the mobile app cannot drift apart.
 */

// --- search -----------------------------------------------------------------

/**
 * PostgREST `or=` filter for the customer list. One definition, used by
 * `apps/web/src/lib/customers.ts` and `apps/mobile/src/lib/customers.ts`.
 *
 * `%`, `,`, `(` and `)` are PostgREST filter syntax, so they are neutralised
 * rather than escaped — the same approach as the property search.
 */
export function customerSearchFilter(term: string): string | null {
  const safe = term.replace(/[%,()*]/g, ' ').trim();
  if (!safe) return null;

  const columns = [
    'full_name',
    'phone',
    'normalized_phone',
    'facebook_name',
    'telegram_username',
    'email',
  ];
  const parts = columns.map((column) => `${column}.ilike.%${safe}%`);

  // "012 345 678" must find a customer stored as +85512345678, so the term is
  // normalised as well and matched against the normalised column.
  const normalized = normalizePhone(safe);
  if (normalized && /\d/.test(safe)) {
    parts.push(`normalized_phone.ilike.%${normalized}%`);
  }
  return parts.join(',');
}

// --- duplicates -------------------------------------------------------------

/**
 * Phone is the only signal allowed to declare two records the same person.
 * Names are never compared: two guests really can both be "Sok Dara", and
 * silently merging them would lose one of their booking histories.
 */
export function isSamePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  return left !== null && left === right;
}

/**
 * Indexes of rows repeating a phone that appeared earlier in the same list.
 * The first occurrence is not a duplicate — it is the row that will be kept.
 */
export function duplicateRowIndexes(phones: readonly (string | null | undefined)[]): Set<number> {
  const seen = new Set<string>();
  const duplicates = new Set<number>();
  phones.forEach((phone, index) => {
    const normalized = normalizePhone(phone);
    if (!normalized) return;
    if (seen.has(normalized)) duplicates.add(index);
    else seen.add(normalized);
  });
  return duplicates;
}

// --- CSV --------------------------------------------------------------------

/** Columns the importer understands. Order matches the sample template. */
export const CUSTOMER_IMPORT_FIELDS = [
  'full_name',
  'phone',
  'email',
  'facebook_name',
  'telegram_username',
  'address',
  'note',
] as const;
export type CustomerImportField = (typeof CUSTOMER_IMPORT_FIELDS)[number];

/** Spreadsheets come from real people, so a few obvious spellings are accepted. */
const HEADER_ALIASES: Record<string, CustomerImportField> = {
  fullname: 'full_name',
  name: 'full_name',
  customer: 'full_name',
  customername: 'full_name',
  guestname: 'full_name',
  phone: 'phone',
  phonenumber: 'phone',
  mobile: 'phone',
  telephone: 'phone',
  tel: 'phone',
  contact: 'phone',
  email: 'email',
  emailaddress: 'email',
  facebook: 'facebook_name',
  facebookname: 'facebook_name',
  fb: 'facebook_name',
  telegram: 'telegram_username',
  telegramusername: 'telegram_username',
  address: 'address',
  note: 'note',
  notes: 'note',
  remark: 'note',
  remarks: 'note',
};

function headerKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Maps a header row onto known fields; unknown columns become `null`. */
export function mapImportHeaders(header: readonly string[]): (CustomerImportField | null)[] {
  return header.map((cell) => HEADER_ALIASES[headerKey(cell)] ?? null);
}

/**
 * Minimal RFC 4180 reader: quoted fields, embedded commas and newlines,
 * doubled quotes, CRLF, and the UTF-8 BOM Excel writes.
 *
 * ponytail: hand-rolled rather than a dependency — the importer needs one
 * loop, and a CSV library would be the only runtime dependency in this package.
 */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines carry no data and would otherwise become empty error rows.
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** Header row + one record per data row, keyed by recognised field. */
export function parseCustomerCsv(text: string): {
  fields: (CustomerImportField | null)[];
  rows: Partial<Record<CustomerImportField, string>>[];
} {
  const [header, ...body] = parseCsv(text);
  if (!header) return { fields: [], rows: [] };

  const fields = mapImportHeaders(header);
  const rows = body.map((cells) => {
    const record: Partial<Record<CustomerImportField, string>> = {};
    fields.forEach((field, index) => {
      if (!field) return;
      const value = (cells[index] ?? '').trim();
      if (value) record[field] = value;
    });
    return record;
  });
  return { fields, rows };
}

/**
 * A leading `=`, `+`, `-`, `@` or tab makes Excel and Sheets treat the cell as
 * a formula. A phone number legitimately starts with `+`, so every such value
 * is prefixed with an apostrophe — hidden by the spreadsheet, inert as a
 * formula.
 */
function escapeCsvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /["\n\r,]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Serialises to CSV with a UTF-8 BOM. Without the BOM, Excel on Windows opens
 * the file in the system code page and Khmer text becomes mojibake.
 */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return `\uFEFF${rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')}\r\n`;
}
