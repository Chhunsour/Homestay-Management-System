# Phase 3 — customers, internal notes, import and export

Phase 3 adds the other half of a booking: the **customer**. A customer is a
guest record owned by one business — a name, a phone number, the messaging
handles Cambodian operators actually use, and internal staff notes.

**Customers never sign in.** There is no guest login, no public profile page and
no customer-facing route anywhere in this phase. Notes in particular are
internal: nothing in `customer_notes` is rendered anywhere a guest could reach.

Still out of scope: bookings, calendars, payments, OCR, receipts, reports,
subscriptions, and any public guest-facing page. The customer detail screen has
a booking-history section, and in this phase it is an empty state on purpose —
no placeholder rows, no fake `bookings` table.

---

## 1. Data model

```
businesses ──< customers ──< customer_notes
```

`customer_notes` carries `business_id` **and** `customer_id`, with a composite
FK, exactly like the Phase 2 child tables:

```sql
foreign key (customer_id, business_id)
  references public.customers (id, business_id) on delete cascade
```

A note can therefore never be filed under one tenant while pointing at another
tenant's customer, and the note policies check membership on the row itself
instead of joining back to `customers`.

### `customers`

| Column                                  | Notes                                                        |
| --------------------------------------- | ------------------------------------------------------------ |
| `id`, `business_id`                      | uuid PK; `unique (id, business_id)` for the composite FK     |
| `full_name`                              | 2–120 chars after trim — one of the two required fields      |
| `phone`                                  | as typed, kept for display; the other required field         |
| `normalized_phone`                       | E.164, **derived by a trigger** — never accepted from a client |
| `phone_secondary`, `normalized_phone_secondary` | same pair, optional                                   |
| `email`, `facebook_name`, `facebook_url`, `telegram_username`, `address`, `note` | optional, all length- and shape-checked |
| `preferred_language`                     | `app_locale`, default `en`                                   |
| `archived_at`                            | soft delete; set only by `set_customer_archived()`           |
| `created_by`, `created_at`, `updated_at` | audit                                                        |

Every text column has a CHECK constraint. `normalized_phone` must match
`^\+[1-9][0-9]{7,14}$` and `telegram_username` must match `^[A-Za-z0-9_]{3,32}$`,
so a malformed value cannot be stored even by a client that skips the form.

**Customers are never hard-deleted.** There is no `DELETE` grant on either
table, because Phase 4 bookings and Phase 5 payments will reference these rows.
Archiving is the delete button.

### `customer_notes`

`body` (1–2000 chars), `created_by`, `created_at`, `updated_at` and
`archived_at`. "Remove" in both UIs sets `archived_at`; the row stays for audit.

---

## 2. Phone normalization

`normalize_phone(text)` in SQL is the deliberate twin of
`packages/shared/src/phone.ts`. Both turn every way of writing one Cambodian
number into the same string:

| Typed              | Normalized      |
| ------------------ | --------------- |
| `012 345 678`      | `+85512345678`  |
| `012-345-678`      | `+85512345678`  |
| `+855 12 345 678`  | `+85512345678`  |
| `85512345678`      | `+85512345678`  |
| `12345678`         | `+85512345678`  |

Rules that matter:

- The leading `0` is a **trunk prefix**, dropped when the country code is added.
- A number that merely *starts* with `855` but is the wrong length is treated as
  a local number, not as a country code (`8551234` is not `+8551234`).
- Foreign numbers written in `+` form keep their own country code untouched.
- Input with no digits normalizes to `null`, which is a validation failure, not
  an empty string stored in the column.

The original string is stored in `phone` and shown everywhere in the UI. Only
matching uses `normalized_phone`.

A `before insert or update of phone, phone_secondary` trigger
(`set_customer_normalized_phone`, `SECURITY DEFINER`) derives both normalized
columns and raises `invalid_phone` (SQLSTATE 22023) when it cannot. **Clients
never send `normalized_phone`** — neither app's `toRow()` includes it. A forged
value would hide a row from duplicate detection, which is exactly the check the
column exists to serve.

---

## 3. Duplicate detection

**Phone only. Never name.** Two guests genuinely can be called ខេម សុភា, and
merging them would destroy one of their booking histories. `isSamePhone()`
compares normalized forms and nothing else; there is no fuzzy name match
anywhere in the codebase, and nothing merges records automatically.

Detection runs in three places:

1. **Before save, in both apps.** `findCustomerByPhone(businessId, phone, excludeId?)`
   looks up the normalized form inside the current business. On a match the save
   stops and the form shows a warning naming the existing customer, with a button
   that opens that record.
2. **In the database.** A partial unique index
   `customers_business_phone_key on (business_id, normalized_phone) where archived_at is null`
   makes a duplicate live number impossible even if two people submit at once.
   Both apps map SQLSTATE `23505` to the translated duplicate message.
3. **Inside a CSV file.** `duplicateRowIndexes()` keeps the first occurrence of
   each phone and flags every later one, so an import cannot fight the unique
   index row by row.

An **archived** match also blocks the save, in both apps. That is a deliberate
choice — restoring the existing record keeps the guest's history in one place —
and it is marked with a `ponytail:` comment naming the upgrade path if a real
business turns out to need two records for one number.

A second index, `customers_phone_lookup_idx`, is **not** partial, so duplicate
detection can see archived rows. Telling staff "that number belongs to someone
you archived" is the answer they need; silence would produce a fork.

**Detection is per business.** Every lookup filters `business_id` on top of RLS,
and RLS restricts the row set to businesses the caller is an active member of.
One business's phone book is invisible to another, in both directions.

---

## 4. Permissions

Four new permissions join `customers.manage`:

| Permission                | Owner | Manager | Staff | Covers                                    |
| ------------------------- | :---: | :-----: | :---: | ----------------------------------------- |
| `customers.manage`        |   ✓   |    ✓    |   ✓   | read, create, edit, add a note            |
| `customers.archive`       |   ✓   |    ✓    |       | archive and restore                       |
| `customers.notes.manage`  |   ✓   |    ✓    |       | remove (archive) someone else's note      |
| `customers.import`        |   ✓   |    ✓    |       | CSV import                                |
| `customers.export`        |   ✓   |    ✓    |       | Excel/CSV export                          |

**Staff cannot bulk export customer data.** That is enforced by
`export_customers()` raising `42501`, not by hiding the button — the export
route re-checks the permission server-side and the RPC checks it again.

The matrix lives in `role_permissions` in SQL and in `ROLE_PERMISSIONS` in
TypeScript. `roles.test.ts` parses the migration and fails if the two disagree.

---

## 5. RLS

Both tables have RLS enabled. `anon` and `authenticated` are revoked, then
`authenticated` is granted `select, insert, update` — **no `DELETE` grant on
either table.**

| Policy                  | Rule                                                                            |
| ----------------------- | ------------------------------------------------------------------------------- |
| `customers_select`      | `has_business_permission(business_id, 'customers.manage')`; **does not** filter archived rows — archived customers stay readable and stay tenant-protected |
| `customers_insert`      | same permission, plus `created_by is null or created_by = auth.uid()`           |
| `customers_update`      | same permission, and `archived_at is null` in **both** USING and WITH CHECK      |
| `customer_notes_select` | `has_business_permission(business_id, 'customers.manage')`                       |
| `customer_notes_insert` | same, plus `created_by is null or created_by = auth.uid()`                       |
| `customer_notes_update` | `has_business_permission(business_id, 'customers.notes.manage')`                 |

Two consequences worth stating plainly:

- **`archived_at` is unreachable through `UPDATE`.** Repeating
  `archived_at is null` in USING and WITH CHECK means a plain UPDATE can neither
  archive a live customer nor edit an archived one. Archiving is only the RPC,
  which checks `customers.archive`.
- **A client-supplied `business_id` buys nothing.** The insert policy evaluates
  the permission against the value the client sent, so a forged id fails the
  membership check instead of bypassing it. Nothing trusts the request body.

---

## 6. RPCs

All three are `SECURITY DEFINER` with `set search_path = public, pg_temp`, and
all three `revoke all … from public` then `grant execute … to authenticated`.
Each derives the caller from `auth.uid()`.

| Function                                              | Behaviour                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `set_customer_archived(uuid, boolean default true)`    | needs `customers.archive`; returns the updated row; `28000` unauthenticated, `P0002` not found, `42501` forbidden |
| `import_customers(uuid, jsonb)`                        | needs `customers.import`; rejects a batch over `CUSTOMER_IMPORT_MAX_ROWS` (500); returns a jsonb array with one `imported` / `duplicate` / `invalid` result **per row**; a `unique_violation` becomes `duplicate`, not an aborted batch |
| `export_customers(uuid, boolean default false, text default null)` | needs `customers.export`; `setof public.customers` scoped to the business, with a null `p_archived` meaning both active and archived and an optional search term matching name, either phone column, the normalized forms and the Telegram handle |

**No partial silent failures.** `import_customers` reports every row's outcome
and the import UI renders the full breakdown — imported, skipped as duplicate,
rejected as invalid, with row numbers. A row that fails is named; nothing is
dropped quietly, and nothing rolls back the rows that did succeed.

**Import cannot reach an unauthorized business.** The business id is a function
argument, and the first thing the function does is check
`customers.import` for the caller *in that business*.

---

## 7. Shared package

Everything a rule depends on lives in `@homestay/shared`, so the two apps cannot
drift:

| Module                       | Adds in Phase 3                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `phone.ts`                   | `normalizePhone`, `isNormalizedPhone`, `isValidPhone`, `CAMBODIA_CALLING_CODE`                        |
| `customers.ts`               | `customerSearchFilter`, `isSamePhone`, `duplicateRowIndexes`, `CUSTOMER_IMPORT_FIELDS`, `mapImportHeaders`, `parseCsv`, `parseCustomerCsv`, `toCsv` |
| `schemas.ts`                 | `customerSchema`, `customerNoteSchema`, `customerImportRowSchema`                                     |
| `constants.ts`               | `CUSTOMER_FILTERS`, `CUSTOMER_PAGE_SIZE` (25), `CUSTOMER_IMPORT_MAX_ROWS` (500)                       |
| `roles.ts`                   | the four new permissions                                                                              |
| `types.ts`                   | `Customer`, `CustomerNote`, `CustomerFilter`                                                          |
| `i18n/`                      | the `customer.*` keys, in `en` and `km`                                                               |

Three of these are worth calling out:

- **`customerSearchFilter(term)`** builds one PostgREST `or=(…)` filter covering
  full name, `phone`, `normalized_phone`, `facebook_name` and
  `telegram_username`. A typed local number is normalized first, so searching
  `012345678` finds a record saved as `+855 12 345 678`. Commas, parentheses and
  quotes in the term are neutralised — PostgREST filter syntax is not a place to
  interpolate user input.
- **`customerImportRowSchema`** is deliberately looser than `customerSchema`: an
  import shows the user which rows are wrong, so a bad row must survive parsing
  long enough to be reported.
- **`toCsv()`** writes a UTF-8 BOM so Excel opens Khmer correctly, and prefixes
  any field starting with `=`, `+`, `-` or `@` so a spreadsheet cannot execute
  an exported value as a formula.

---

## 8. Web (`apps/web`)

The Guests placeholder is gone. `(app)/guests/` is now:

| Route                | What it is                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `page.tsx`           | table with server-side search and an active / archived / all filter, both in `searchParams`; paginated |
| `new/page.tsx`       | create form                                                                                      |
| `[id]/page.tsx`      | detail — contact card, internal notes, archive/restore, booking-history empty state              |
| `[id]/edit/page.tsx` | edit form                                                                                        |
| `import/page.tsx`    | CSV import wizard                                                                                |
| `export/route.ts`    | CSV download                                                                                     |

Components in `src/components/customers/`: `CustomerForm`, `CustomerNotes`,
`CustomerStatusActions`, `ImportWizard`. Mutations are Server Actions returning
the same `ActionState` (`status`, `messageKey`, `fieldErrors`) as Phase 2, so
error text is always a translation key. Styling follows the existing design
system — mostly rectangular, `rounded-sm`.

### Import wizard

1. Pick a file. `parseCsv` handles quotes, embedded commas, CRLF and the BOM.
2. `mapImportHeaders` matches column names loosely and ignores unknown columns.
3. **Preview before import** — every row is shown with its status: valid,
   invalid (with the reason), duplicate within the file, or already in the
   database.
4. Duplicate and invalid rows can be skipped; the rest are sent to
   `import_customers`.
5. Success and error summaries afterwards, per row.

A sample template is downloadable at `/customers-sample.csv`.

### Export

`GET /guests/export` re-checks `customers.export` server-side, calls
`export_customers` for the selected business, honours the current active /
archived filter **and the current search term**, and streams CSV with readable
column headers translated into the caller's locale. Internal
technical fields (`id`, `business_id`, `created_by`, `normalized_phone*`) are
excluded — an export is for a human, and a normalized column would only make the
file look like a database dump.

---

## 9. Mobile (`apps/mobile`)

| Route                       | What it is                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| `(tabs)/customers.tsx`      | list with debounced search, filter chips, pagination              |
| `customer/new.tsx`          | create                                                            |
| `customer/[id]/index.tsx`   | detail, notes, archive/restore, booking-history empty state       |
| `customer/[id]/edit.tsx`    | edit (redirects to the detail screen for an archived customer)    |

`src/lib/customers.ts` is the data layer and `src/components/CustomerForm.tsx`
and `CustomerNotes.tsx` are shared between create and edit.

- **Search is debounced 300 ms** with a plain `setTimeout` effect — typing does
  not fire a query per keystroke.
- **Pagination** is a growing `range(0, page * CUSTOMER_PAGE_SIZE)` that fetches
  one extra row to answer "is there more?" without a second count query.
- The list reloads on focus (`useFocusEffect`), so an edit shows on the way back.
- Archive and note removal go through a native `Alert.alert` confirm.
- Every screen renders loading, empty, search-empty, validation-error,
  duplicate-warning, success and network-error states.

Notes show a timestamp but no author name — the app has no member directory yet.
That is marked with a `ponytail:` comment rather than built speculatively.

---

## 10. Localization

No visible string is written inside a screen. Every `customer.*` key exists in
both `en` and `km`, and two tests guard the pair: one fails if a Khmer value is
still the English string, another if a Khmer value contains no Khmer codepoints.
Validation messages are themselves keys, so a field error is translated where it
is rendered.

CSV export writes a BOM so Khmer survives the trip through Excel, and
`toCsv`/`parseCsv` round-trip Khmer text with quoted separators — there is a test
for exactly that.

---

## 11. Migrations added

| File                                    | Contents                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `20260804000900_customers.sql`          | `normalize_phone`, `customers`, `customer_notes`, the normalization trigger, CHECK constraints, both phone indexes, updated-at triggers |
| `20260804001000_customers_rls.sql`      | the four new permissions, REVOKE/GRANT, and the six RLS policies                  |
| `20260804001100_customers_rpc.sql`      | `set_customer_archived`, `import_customers`, `export_customers`                   |

---

## 12. Deliberate omissions

- **No booking or payment tables.** The history section is an empty state.
  Placeholder rows would only teach staff to distrust the screen.
- **No merge tool.** Duplicate detection warns and links; a human decides. Two
  records are recoverable, a wrong merge is not.
- **No name-based matching of any kind.**
- **No hard delete, and no dev-only purge utility.** If one is ever added it
  stays server-side and disabled in production.
- **No note authorship display.** The mobile app has no member directory; add it
  with the members screen.
- **No customer tags, segments, loyalty or marketing consent** — nothing needs
  them until bookings exist.
- **No import from Excel binary formats.** CSV only; the sample template shows
  the expected columns.
