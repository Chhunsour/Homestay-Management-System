# Phase 3 testing

What proves the customer, note, duplicate-detection, import and export work.
The Phase 1 and Phase 2 plans ([PHASE_1_TESTING.md](PHASE_1_TESTING.md),
[PHASE_2_TESTING.md](PHASE_2_TESTING.md)) still apply unchanged — nothing here
replaces them, and section 6 below re-runs both as a regression check.

## 1. Automated checks

```bash
npm run lint          # eslint, flat config, repo-wide
npm run typecheck     # tsc --noEmit in all three workspaces
npm test              # packages/shared unit tests (node --test)
npm run build         # production build of apps/web
npm run format:check  # prettier
```

`npm run lint` is clean apart from the two long-standing `no-console` warnings
in `supabase/tests/smoke.mjs`, which is a CLI script and prints its results.

### What `npm test` adds in Phase 3

`packages/shared/src/phone.test.ts` — normalization, the thing every other
customer rule is built on:

| Test                                                          | Asserts                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| every way of writing one Cambodian number normalises the same  | spaces, dashes, parentheses, `+855`, `00855`, `855`, bare 8 digits all → `+85512345678` |
| 9-digit and no-trunk-prefix local numbers work too             | `077123456` → `+85577123456`; a number typed without the leading `0`      |
| foreign numbers keep their own country code                    | `+66812345678` stays Thai, in `+`, `(+66)` and `0066` forms                |
| a local number that merely starts with 855 is not a country code | `0855123456` → `+855855123456`, not `+855123456`                        |
| input with no digits normalises to null                        | `'not a phone'`, `'+'` and `''` are failures, not empty strings           |
| `isNormalizedPhone` enforces the E.164 shape                   | `+` then 8–15 digits, no leading zero after the `+`                       |
| `isValidPhone` rejects numbers too short to dial               | length is validated, not just character class                              |

`packages/shared/src/customers.test.ts` — duplicates, search and CSV:

| Test                                                       | Asserts                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| duplicates are decided by phone, never by name              | two identical names with different numbers are two people; two spellings of one number are one |
| `duplicateRowIndexes` keeps the first row and flags the later ones | the surviving row is the first occurrence, so an import is deterministic     |
| a file with no repeated phone has no duplicates             | the detector does not invent matches                                                |
| search covers name, both phone columns, Facebook and Telegram | every documented search field is in the generated filter                          |
| a typed local number also searches its normalised form      | typing `012345678` finds a record stored as `+855 12 345 678`                        |
| PostgREST filter syntax in the term is neutralised          | commas, parentheses and quotes cannot break out of the `or=(…)` filter               |
| `parseCsv` handles quotes, embedded commas, CRLF and the BOM | the real files Excel produces, not an idealised one                                 |
| import headers are matched loosely and unknown columns ignored | header casing and spacing vary; an extra column is not an error                    |
| `parseCustomerCsv` yields one record per data row           | no off-by-one on the header row                                                      |
| exported CSV carries a BOM and defuses spreadsheet formulas | a field starting `=`, `+`, `-` or `@` cannot execute when opened                     |
| CSV round-trips Khmer text and quoted separators            | export → import returns the same Khmer strings                                       |

`roles.test.ts` parses `20260804001000_customers_rls.sql` as well, so the four
new permissions must exist identically in SQL and in TypeScript or the suite
fails.

The i18n tests cover the new `customer.*` keys automatically: one fails if a
Khmer value is still the English string, another if a Khmer value contains no
Khmer codepoints.

## 2. SQL tenant isolation suite

```bash
export SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres
npm run db:test        # supabase db reset, then all three SQL suites
npm run db:test:sql    # all three suites, no reset
```

`db:test:sql` now runs `rls_isolation.sql` (Phase 1), `rls_properties.sql`
(Phase 2) and `rls_customers.sql` (Phase 3). All three run inside a rolled-back
transaction and abort on the first failed assertion, so they are safe against a
populated database.

To run only the Phase 3 suite:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_customers.sql
```

Against bare PostgreSQL (CI, no Docker), load `auth_stub.sql` and all eleven
migrations first — the Phase 1 doc has the full command; add migrations `…0900`
through `…1100` to its list.

### Expected output

```
            result
-------------------------------
 ALL CUSTOMER RLS TESTS PASSED
```

Anything else is a failure. `assert_rejected` re-raises its own assertion
errors, so a statement that was supposed to be blocked but succeeded cannot be
mistaken for a pass. Where RLS **filters** rather than raises — a cross-tenant
`UPDATE`, a staff edit of somebody else's note — the suite asserts the row's
value afterwards instead of the statement's success, because a filtered UPDATE
is a silent no-op.

### The fixture: two businesses, five users, both roles on each side

| Business | Members                                    |
| -------- | ------------------------------------------ |
| ALPHA    | alice (owner), mark (manager), sam (staff) |
| BETA     | bella (owner), stan (staff)                |

BETA holds customers and notes of its own on purpose, including **the same guest
phone number as ALPHA** — "returned 0 rows" can then never be a false pass
caused by an empty table, and the shared number proves duplicate detection is
scoped per business rather than global.

| # | Section                | Asserts                                                                                                                                                       |
| - | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `normalize_phone()`    | the SQL function agrees with `packages/shared/src/phone.ts` on all 17 cases the TS unit tests use — if the two drift, a customer typed on the web stops matching the same customer typed on mobile |
| 2 | Staff create and edit  | the trigger derives both normalized columns and preserves the typed number; Khmer survives the round trip; a **client-supplied `normalized_phone` is overwritten**, not trusted; `created_by` cannot be attributed to somebody else; a non-number is refused; staff may correct contact details and add notes |
| 3 | Duplicate detection    | the same number spelled differently is rejected inside one business; **the same name with a different number creates a second customer, never a merge**; the same guest may exist in both businesses independently |
| 4 | Cross-tenant isolation | asserted from **both** sides — BETA reads no ALPHA customer or note and ALPHA's owner reads no BETA row; a forged `business_id` cannot insert; a note cannot be attached to another tenant's customer, in either direction; a customer cannot be **reassigned** to another business; cross-tenant updates are asserted on effect |
| 5 | Notes                  | staff may write a note but cannot edit, archive or delete one; manager can correct and archive; neither notes nor customers can be deleted at all               |
| 6 | Archiving              | staff cannot archive, by RPC **or** by plain `UPDATE`; manager can archive and restore; an archived customer stays readable inside its own business but is read-only; archiving frees the number, and restoring into a taken number is refused rather than creating two live records; an archived customer is still invisible to, and unrestorable by, the other tenant |
| 7 | Import                 | staff are refused; ALPHA cannot import into BETA; a mixed batch returns `["imported","duplicate","invalid","invalid"]` — **one honest outcome per row**; the valid Khmer row lands, the invalid rows do not, and the importer is recorded as `created_by`; a 501-row batch is rejected as a real limit, not a UI convention |
| 8 | Export                 | **staff of either business are refused**; ALPHA's owner cannot export BETA; the result never leaks another business's rows; the archived / active / both filters return exactly what they claim; the search term matches the typed number, the normalized number, a Khmer name and a Telegram handle |
| 9 | Anonymous callers      | `anon` reads neither table and cannot call `set_customer_archived`, `import_customers` or `export_customers` — privileges are revoked outright, so it fails before RLS is consulted |

## 3. HTTP smoke test

```bash
export SUPABASE_ANON_KEY=...          # both from `npx supabase status`
export SUPABASE_SERVICE_ROLE_KEY=...
npm run db:smoke
```

**Phase 3 adds no checks to `smoke.mjs`.** It stays at the 32 Phase 1–2
assertions and must still pass — the customer tables introduce no new storage
bucket and no composite-FK embed that PostgREST's schema cache could break, so
there is nothing here that SQL cannot already see. Run it anyway before
shipping; it is the regression guard on the schema change.

Last line printed is `ALL SUPABASE SMOKE TESTS PASSED`; the process exits
non-zero otherwise.

## 4. Manual checks — web

Sign in as an owner with at least two customers.

### List, search, filters

- `/guests` shows a table, not the old placeholder.
- Search matches full name, the number **as typed**, the normalized number,
  Facebook name and Telegram username. Typing `012345678` finds a guest saved as
  `+855 12 345 678`.
- The active / archived / all filter changes the result set, and both the term
  and the filter survive in the URL — reload and back both work.
- With more than 25 customers, pagination appears and the second page is
  different rows.
- The empty state text differs between "no customers yet" and "nothing matched".

### Create, edit, duplicates

- `/guests/new` requires **only** full name and phone; everything else is
  optional.
- Submitting a 1-char name shows a translated field error, not a stack trace.
- `call me` as a phone is rejected before it reaches the database.
- Creating a second customer with a number already on file shows the duplicate
  warning naming the existing customer, and the "open" button lands on that
  record.
- The same is true when the existing match is **archived** — the warning says so
  and restoring is the offered path.
- Two customers with the same name and different numbers both save. Nothing
  merges.
- Editing a customer to a number that belongs to another live customer is
  refused with the same message.

### Detail, notes, archive

- The detail page shows the typed phone, not the normalized one.
- Adding a note works as staff; the note lists with its timestamp.
- Removing a note is available to owner and manager only, and asks for
  confirmation.
- The booking-history section shows a polished empty state — **no rows, no
  "coming soon" table of fake bookings**.
- Archive asks for confirmation, the customer leaves the active list, appears
  under the archived filter, and the edit form is unreachable until restored.
- Restore puts it back; restoring into a number taken by a live customer shows
  the duplicate error rather than creating two live records.

### Import

- `/guests/import` accepts a CSV and shows a **preview before importing**.
- The sample template downloads from the link on the page
  (`/customers-sample.csv`) and imports cleanly as-is.
- A file with a repeated phone flags the later rows as duplicates within the
  file.
- A file with a phone already in the database flags those rows as existing
  matches.
- A row with an empty name or an unusable phone is flagged invalid with a
  reason.
- Skipping the flagged rows and importing the rest produces a summary naming
  what was imported, what was skipped and why — and the good rows are actually
  in the database afterwards.
- A file with a UTF-8 BOM, CRLF line endings and quoted commas parses correctly.
- Khmer names survive the import and display correctly on the list.

### Export

- The export button is visible to owner and manager, and the file downloads.
- The file opens in Excel with Khmer rendering correctly (the BOM).
- Column headers are readable words, and `id`, `business_id`, `created_by` and
  the `normalized_phone*` columns are **not** in the file.
- Exporting with the archived filter selected exports archived customers only.
- A cell whose value starts with `=` is prefixed so Excel does not execute it.

## 5. Manual checks — mobile

```bash
npx expo config --type public   # must print without error
npm run dev:mobile
```

- The Customers tab shows the real list, not the placeholder.
- Typing in search does **not** fire a query per keystroke — results settle
  about 300 ms after you stop.
- Filter chips (active / archived / all) match the web results.
- "Show more" appends the next page; the count line matches.
- Tapping a row opens the detail screen; contact fields that are unset show the
  "not set" label, not an empty gap.
- Saving an edit and going back shows the change in the list (it reloads on
  focus).
- Creating a customer with a number already on file shows the duplicate banner
  and the "open existing" button navigates to that record.
- Adding a note works; removing one asks through a native confirm and is only
  offered to owner and manager.
- Archive and restore go through a native confirm and show a success banner.
- The booking-history section is an empty state.
- Turn airplane mode on and save: the network-error banner appears with a retry,
  not a crash.

## 6. Permissions — the check that matters

Do this with three real accounts in one business. Hidden UI is not the test; the
point is that the **API** refuses.

| Actor   | Expect                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| Owner   | everything                                                                                                               |
| Manager | everything — for customers a manager has the same rights as an owner                                                     |
| Staff   | read, create, edit, add notes. **No** archive, **no** note removal, **no** import, **no** export button — and each of those returns 403 if called directly |

Then bypass the UI for staff:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/export_customers" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $STAFF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"p_business_id":"<id>"}'
```

It must return a `42501` error. Repeat with `import_customers` and
`set_customer_archived`. Section 7, 8 and 6 of the SQL suite assert the same
thing, but doing it once by hand confirms the token, the policy and the RPC line
up in the deployed environment.

Then try the tenancy bypass by hand, as an owner of business A against a
customer id belonging to business B:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/set_customer_archived" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H 'Content-Type: application/json' -d '{"p_customer_id":"<B customer id>"}'
```

It must fail. Knowing another tenant's uuid must buy nothing.

## 7. Phase 1 and 2 regression

Phase 3 added four permissions and two tables; it did not change
authentication, onboarding, properties, pricing, photos or availability.
Re-run before closing the phase:

- `npm run db:test` — the Phase 1 and Phase 2 suites run first and must still
  pass.
- `npm run db:smoke` — auth, PostgREST embeds and Storage are unchanged.
- Manually: sign in, switch language between English and Khmer on both apps,
  open a property, upload a photo, create and cancel a block.

## 8. Results at the close of Phase 3

Run on 2026-08-05 against the local Supabase stack (CLI 2.109.1, Node 24):

| Command                            | Result                                                     |
| ---------------------------------- | ------------------------------------------------------------ |
| `npm run lint`                     | 0 errors, 2 pre-existing `no-console` warnings               |
| `npm run typecheck`                | clean in all three workspaces                                 |
| `npm test`                         | 37 passed, 0 failed                                           |
| `npm run format:check`             | clean                                                         |
| `npm run build`                    | succeeded; all six `/guests*` routes present                  |
| `npx expo config --type public`    | valid (SDK 57)                                                |
| `supabase db reset`                | all eleven migrations applied                                 |
| `rls_isolation.sql`                | ALL RLS ISOLATION TESTS PASSED                                |
| `rls_properties.sql`               | ALL PROPERTY RLS TESTS PASSED                                 |
| `rls_customers.sql`                | ALL CUSTOMER RLS TESTS PASSED                                 |
| `npm run db:smoke`                 | 32 checks, ALL SUPABASE SMOKE TESTS PASSED                    |
