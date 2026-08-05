import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  customerSearchFilter,
  duplicateRowIndexes,
  isSamePhone,
  mapImportHeaders,
  parseCsv,
  parseCustomerCsv,
  toCsv,
} from './customers.ts';

// --- duplicate detection ----------------------------------------------------

test('duplicates are decided by phone, never by name', () => {
  assert.equal(isSamePhone('012345678', '+855 12 345 678'), true);
  assert.equal(isSamePhone('012345678', '012345679'), false);
  // No phone means no match — a blank must never collide with another blank.
  assert.equal(isSamePhone('', ''), false);
  assert.equal(isSamePhone(null, '012345678'), false);
});

test('duplicateRowIndexes keeps the first row and flags the later ones', () => {
  const rows = [
    '012345678', // 0 — kept
    '077000111', // 1 — kept
    '+85512345678', // 2 — same person as row 0
    '', // 3 — no phone, not a duplicate
    '012 345 678', // 4 — same person as row 0 again
    '077000112', // 5 — kept
  ];
  assert.deepEqual([...duplicateRowIndexes(rows)].sort(), [2, 4]);
});

test('a file with no repeated phone has no duplicates', () => {
  assert.equal(duplicateRowIndexes(['012345678', '012345679', null]).size, 0);
});

// --- search -----------------------------------------------------------------

test('search covers name, both phone columns, Facebook and Telegram', () => {
  const filter = customerSearchFilter('dara')!;
  for (const column of ['full_name', 'phone', 'normalized_phone', 'facebook_name']) {
    assert.ok(filter.includes(`${column}.ilike.%dara%`), column);
  }
});

test('a typed local number also searches its normalised form', () => {
  const filter = customerSearchFilter('012 345 678')!;
  assert.ok(filter.includes('normalized_phone.ilike.%+85512345678%'));
});

test('PostgREST filter syntax in the term is neutralised', () => {
  const filter = customerSearchFilter('a,b(c)%d')!;
  assert.equal(filter.includes('('), false);
  assert.equal(filter.split(',').length, 6, 'commas in the term must not add filters');
  assert.equal(customerSearchFilter('   '), null);
});

// --- CSV --------------------------------------------------------------------

test('parseCsv handles quotes, embedded commas, CRLF and the BOM', () => {
  const text = '\uFEFFa,b\r\n"x,1","he said ""hi"""\r\n\r\nplain,value\r\n';
  assert.deepEqual(parseCsv(text), [
    ['a', 'b'],
    ['x,1', 'he said "hi"'],
    ['plain', 'value'],
  ]);
});

test('import headers are matched loosely and unknown columns ignored', () => {
  assert.deepEqual(mapImportHeaders(['Full Name', 'Phone Number', 'FB', 'Loyalty Tier']), [
    'full_name',
    'phone',
    'facebook_name',
    null,
  ]);
});

test('parseCustomerCsv yields one record per data row', () => {
  const { rows } = parseCustomerCsv(
    'Name,Phone,Note\nSok Dara,012 345 678,Repeat guest\nចន្ទ សុភា,+85577123456,\n',
  );
  assert.deepEqual(rows, [
    { full_name: 'Sok Dara', phone: '012 345 678', note: 'Repeat guest' },
    { full_name: 'ចន្ទ សុភា', phone: '+85577123456' },
  ]);
});

test('exported CSV carries a BOM and defuses spreadsheet formulas', () => {
  const csv = toCsv([
    ['Full name', 'Phone'],
    ['=cmd|calc', '+85512345678'],
  ]);
  assert.ok(csv.startsWith('\uFEFF'), 'missing BOM: Excel would mangle Khmer text');
  assert.ok(csv.includes("'=cmd|calc"));
  assert.ok(csv.includes("'+85512345678"));
});

test('CSV round-trips Khmer text and quoted separators', () => {
  const rows = [
    ['Full name', 'Address'],
    ['ចន្ទ សុភា', 'ផ្ទះលេខ ១២, ភ្នំពេញ'],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});
