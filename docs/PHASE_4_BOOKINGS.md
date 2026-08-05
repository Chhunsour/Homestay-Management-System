# Phase 4 — bookings, availability calendar, pricing and conflict control

Phase 4 joins the three halves Phases 1–3 built: a **property** (Phase 2) is
reserved for a **customer** (Phase 3) inside a **business** (Phase 1). A booking
takes the whole property for a half-open range `[check_in_at, check_out_at)` —
there is still no room-level inventory, because a homestay rents complete units.

Nobody outside the team touches any of this. Guests do not sign in, do not
submit bookings and have no page anywhere in the app; staff enter every booking
from a Messenger thread, a Telegram message or a phone call.

Still out of scope, and deliberately absent rather than stubbed: payments,
receipt OCR, invoices, revenue reports, subscriptions and any public page. The
dashboard shows counts of bookings, never money totals — half a revenue figure
is worse than none.

---

## 1. Data model

```
businesses ──< booking_statuses ──┐
           ├──< properties ───────┤
           ├──< customers ────────┼──< bookings ──< booking_status_history
           └──< booking_counters ─┘
```

### `booking_statuses`

Per business, seeded on creation, editable afterwards.

| Column                            | Notes                                                          |
| --------------------------------- | -------------------------------------------------------------- |
| `id`, `business_id`               | uuid PK; `unique (id, business_id)` for the composite FK        |
| `name`                            | 2–40 chars; unique per business, compared case-insensitively    |
| `code`                            | `booking_status_code` enum — the **internal** vocabulary        |
| `color`                           | `#rrggbb`, CHECK-enforced                                       |
| `sort_order`                      | 0–999, the display order                                        |
| `is_system`                       | one of the four seeded rows; cannot be deleted or recoded       |
| `is_active`                       | a disabled status stays on old bookings but is no longer offered |
| `created_at`, `updated_at`        | audit                                                           |

**System behaviour never reads `name`.** Every rule in this system — what holds
dates, what starts a hold, what releases one, what needs the cancel permission —
is written against `code`, one of `pending`, `confirmed`, `completed`,
`cancelled`. An owner can rename "Pending" to "Reserved" or "កក់ទុក" and nothing
changes but the label.

Two indexes carry that guarantee: `booking_statuses_name_key` on
`(business_id, lower(btrim(name)))`, and a partial unique index
`booking_statuses_system_key on (business_id, code) where is_system` — exactly
one built-in row per code per business, which is what `findStatusByCode()` in
the shared package relies on.

Seeding is an `after insert` trigger on `businesses`, not an edit to
`create_business()`, so **any** path that creates a business ends up with a
usable status list. Businesses that already existed when the migration ran were
back-filled by the same statement list.

`guard_system_booking_status()` refuses to delete a system row or to change its
`code` / `is_system`. Renaming, recolouring, reordering and disabling stay open.

### `bookings`

| Column                                              | Notes                                                       |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `id`, `business_id`                                  | uuid PK; `unique (id, business_id)`                          |
| `booking_number`                                     | `BK-2026-000001`, unique per business, CHECK-shaped          |
| `property_id`, `customer_id`, `status_id`            | composite FKs into the same business (see below)             |
| `check_in_at`, `check_out_at`                        | `timestamptz`; CHECK `check_out_at > check_in_at`            |
| `currency`                                           | `app_currency` (USD or KHR), copied from the property's rate card |
| `calculated_price`                                   | what the rate card said at the time                          |
| `final_price`                                        | what is actually owed                                        |
| `price_overridden`, `price_override_reason`          | CHECK: an override without a ≥3-char reason cannot be stored |
| `exchange_rate`                                      | only when the booking currency differs from the business default; Phase 5 reads it instead of guessing a historical rate |
| `source`                                             | `facebook`, `telegram`, `phone`, `walk_in`, `website`, `other` |
| `note`, `internal_note`                              | ≤2000 chars each; the second is never shown to a guest       |
| `pending_expires_at`, `pending_resolved_at`          | the hold, and the human decision that closed it              |
| `conflict_override`, `_reason`, `_by`, `_at`         | CHECK: an override requires reason **and** approver **and** timestamp |
| `cancelled_at`                                       | stamped by a trigger when the status code becomes `cancelled` |
| `created_by`, `updated_by`, `created_at`, `updated_at` | audit                                                      |

**The guest's name and phone are not here.** They live on `customers` and are
read through the embed — one guest, one record, one place to correct a typo.

**The composite foreign keys are the tenant guarantee:**

```sql
foreign key (property_id, business_id) references public.properties (id, business_id)
foreign key (customer_id, business_id) references public.customers  (id, business_id)
foreign key (status_id,   business_id) references public.booking_statuses (id, business_id)
```

A booking therefore *cannot* point at another business's property, customer or
status, whatever a client sends — this is a schema-level fact, not a policy that
has to be remembered. All three are `on delete restrict`: a property or customer
with bookings cannot vanish underneath them.

Indexes: `(property_id, check_in_at, check_out_at)` for the overlap scan,
`(business_id, check_in_at desc)` for the list, one each on `customer_id`,
`status_id` and `(business_id, booking_number)`, plus a partial index
`(business_id, pending_expires_at) where pending_expires_at is not null and
pending_resolved_at is null` — the expired-hold review list comes straight off
an index rather than a table scan.

**No DELETE grant on any Phase 4 table.** A booking is cancelled or archived,
never erased.

### `booking_status_history`

`business_id`, `booking_id` (composite FK), `from_status_id`, `to_status_id`,
`changed_by`, `changed_at`. Written by an `after insert or update of status_id`
trigger running `SECURITY DEFINER`, so no client ever needs INSERT on it. It
answers "who cancelled this, and when" without a general audit-log table.

### `booking_counters`

`(business_id, year, last_number)`. **No grants and no policies** — only the
`SECURITY DEFINER` numbering function touches it. See §3.

---

## 2. Pricing

`priceBooking()` in `packages/shared/src/bookings.ts` and
`booking_calculated_price()` in SQL are deliberate twins. The apps use the first
to show a live preview; the database uses the second to decide what is stored.

**Weekday = Monday–Thursday. Weekend = Friday, Saturday, Sunday.** The rate for
a day is the property's `weekday_price` or `weekend_price` from its
`rule_type = 'base'` pricing row, in that row's currency.

**Days are counted in the business's own time zone** (`business_settings.timezone`,
defaulting to `Asia/Phnom_Penh`), never the server's. A stay checking in at
23:00 Phnom Penh on a Thursday is a Thursday, not the Friday it already is in
UTC. `zonedTimeToUtc()` / `utcToZonedInput()` do the conversion from `Intl` in
two passes, so the pair stays correct across a DST boundary in zones that have
one.

Charging is per night: arriving Monday and leaving Wednesday is Monday +
Tuesday. **A same-day stay is charged as one day** — that is how day-use
bookings are quoted here, and both implementations use the same
`greatest(1, …)` / `Math.max(1, …)` rule.

Totals are rounded to two decimals once, at the end, so summing rates like 32.55
leaves no float dust.

### Manual override

`final_price` is `calculated_price` unless someone overrides it. Overriding
requires `bookings.price.override` (owner or manager) **and** a reason of at
least 3 characters. Both are checked in `save_booking()`, and the reason
requirement is repeated as a CHECK constraint — a price nobody has to justify is
a price nobody can audit later.

**Historical totals are never recomputed.** Raising a property's weekday rate in
June does not rewrite what May's guests were quoted: the numbers live on the
booking row, and nothing recalculates them. The one exception is explicit —
editing a booking's dates or property re-quotes it, because the old quote
belonged to dates that no longer exist. Both apps warn before that replaces a
manually overridden price.

**The client's number is never trusted.** `save_booking()` recomputes
`calculated_price` itself from the property's rate card and stores its own
result; whatever the form posted was a preview. Only `p_final_price` can change
the outcome, and only with the permission and the reason.

Tests in `packages/shared/src/bookings.test.ts` cover weekday-only,
weekend-only, mixed, single-day, multi-day, fractional rates, the manual
override, the time-zone boundary (a stay that crosses midnight UTC still starts
on its local date) and a backwards range.

---

## 3. Booking numbers

`BK-<year>-<six digits>`, e.g. `BK-2026-000001`. The year comes from the
check-in date **in the business's time zone**; the sequence is per business and
per year.

```sql
insert into public.booking_counters (business_id, year, last_number)
values (p_business_id, v_year, 1)
on conflict (business_id, year)
do update set last_number = public.booking_counters.last_number + 1
returning last_number into v_seq;
```

The upsert takes a row lock, so two concurrent requests **queue** instead of
racing to the same number, and `bookings_number_key unique (business_id,
booking_number)` is the backstop if anything ever gets past that.

**The counter is scoped per business**, so `BK-2026-000001` says nothing about
anyone else's volume — a shared global sequence would leak how many bookings
every other tenant on the platform has taken.

---

## 4. Availability and conflicts

`booking_conflicts()` is the single definition of "these dates are taken". It
returns a JSON array, never a boolean, so every caller can say *why*:

| `kind`               | Means                                                     |
| -------------------- | --------------------------------------------------------- |
| `property_archived`  | the property is archived — not a conflict, the wrong property |
| `property_inactive`  | `is_active = false`, same                                  |
| `block`              | an **active** Phase 2 `property_blocks` row overlaps       |
| `booking`            | another booking in a blocking status overlaps              |

**Ranges are half-open** — `tstzrange(a, b, '[)') &&` in SQL, `rangesOverlap()`
in TypeScript. A stay ending at 12:00 and one starting at 12:00 are neighbours,
not a clash. **Back-to-back bookings are allowed**, which is the normal case in
a busy season, and both implementations have a test that says so.

Which bookings hold their dates is decided by `code`, not by name:

- `pending`, `confirmed`, `completed` — hold the dates.
- `cancelled` — hands them back.
- **An expired pending hold still holds the dates.** See §5.

Cancelled blocks (`status = 'cancelled'`) are ignored, matching Phase 2.

### Where the check runs

| Layer | What it does |
| ----- | ------------ |
| Form  | `checkAvailability()` / `check_booking_availability()` show the warning while the user is still typing |
| RPC   | `save_booking()` and `set_booking_status()` re-run `booking_conflicts()` **inside the transaction, after taking a lock** |

The client-side check is a courtesy. The RPC's is the rule.

### The race

```sql
perform pg_advisory_xact_lock(hashtextextended(p_property_id::text, 0));
```

Everyone touching one property serialises on one transaction-scoped advisory
lock, taken **before** the conflict scan. The second of two simultaneous
requests therefore scans *after* the first has inserted, sees its booking, and
is refused. `smoke.mjs` fires two identical bookings concurrently over HTTP and
asserts exactly one wins and the loser comes back as `booking_conflict`.

### Overriding

An overlap is refused by default, with SQLSTATE `23P01` and the conflict array
in the error's DETAIL — so the UI can name what is in the way rather than saying
"unavailable". To go ahead anyway the caller must:

1. pass `p_conflict_override => true`,
2. hold `bookings.conflict.override` — **owner or manager only**, checked
   server-side in the RPC, and
3. supply a reason of at least 3 characters.

The row then records `conflict_override`, `conflict_override_reason`,
`conflict_override_by` and `conflict_override_at` — who approved it and when —
and a CHECK constraint makes an override without all three unstorable.

**Staff cannot override a conflict.** They do not hold the permission, the RPC
raises `42501`, and the SQL suite asserts a staff attempt fails even when the
override flag and a reason are supplied.

**An archived or inactive property is not overridable** — `save_booking()`
raises `property_unavailable` before the override branch is reached, and
`isOverridable()` in the shared package tells the UI not to offer the option.

---

## 5. Pending expiration

A booking entering `pending` gets `pending_expires_at = now() + 30 minutes`
(`PENDING_EXPIRY_MINUTES`), set by the `apply_booking_status()` trigger — so it
is true no matter which path wrote the row. Leaving `pending` clears both hold
columns; entering it again starts a fresh hold.

**Expiry never releases the dates.** That is the whole design. A hold that lapses
becomes a review item:

- `isPendingExpired(booking, now)` — pending, past its hold, `pending_resolved_at`
  still null. Application-side, evaluated at read time, so no scheduled job is
  required for the feature to work today.
- The dashboard shows an expired-holds banner and list on both apps; the booking
  list has an `expired` filter; the detail screen shows a review block.
- An owner or manager (`bookings.pending.resolve`) then calls
  `resolve_pending_booking(id, 'keep' | 'release')`:
  - **keep** stamps `pending_resolved_at`, so it leaves the review list while
    staying pending and still holding the dates;
  - **release** moves it to the system `cancelled` status, which is what actually
    hands the dates back.

Nothing cancels a booking because time passed. A guest who is slow to confirm
does not silently lose their room.

### Recommended production scheduling

The application-side detection above is sufficient and is what ships. When you
want the review list to reach people who are not looking at the dashboard, add a
scheduled job — the schema is already shaped for it, and the partial index
`bookings_pending_idx` is the query plan:

```sql
-- Supabase: enable the extensions once, in the dashboard or a migration.
create extension if not exists pg_cron;

select cron.schedule('booking-holds', '*/5 * * * *', $$
  select public.notify_expired_holds();   -- to be written in Phase 5
$$);
```

Recommended shape when it is built:

- **Every 5 minutes** is frequent enough for a 30-minute hold and cheap enough to
  ignore.
- The job **must not cancel anything.** It notifies; a human still decides.
  Making the job release dates would undo the rule this section exists to state.
- Scope each run to one business at a time and read through the partial index:
  `where pending_expires_at < now() and pending_resolved_at is null`.
- On Supabase, either `pg_cron` calling a `SECURITY DEFINER` function or a
  scheduled Edge Function hitting an RPC with the service key. Prefer `pg_cron`
  — no network hop, no key to leak.
- Make it idempotent (a `notified_at` column, added then) so a retry does not
  send a second message.

---

## 6. Permissions

`bookings.manage` already existed from Phase 1 for all three roles and keeps its
meaning: view, create, edit, link a customer, add notes. Phase 4 adds six.

| Permission                  | Owner | Manager | Staff | Covers                                     |
| --------------------------- | :---: | :-----: | :---: | ------------------------------------------ |
| `bookings.manage`           |   ✓   |    ✓    |   ✓   | view, create, edit, notes, change status    |
| `bookings.statuses.manage`  |   ✓   |         |       | add / rename / recolour / reorder / disable statuses |
| `bookings.conflict.override`|   ✓   |    ✓    |       | book over an existing booking or block      |
| `bookings.price.override`   |   ✓   |    ✓    |       | charge something other than the rate card   |
| `bookings.cancel`           |   ✓   |    ✓    |       | cancel a booking                            |
| `bookings.restore`          |   ✓   |         |       | reopen a cancelled booking                  |
| `bookings.pending.resolve`  |   ✓   |    ✓    |       | rule on an expired hold                     |

Restoring is the owner's alone: it is the one action that can take dates back
from whoever was given them after the cancellation.

The matrix lives in `role_permissions` in SQL and `ROLE_PERMISSIONS` in
TypeScript; `roles.test.ts` parses the migration and fails if they drift.

---

## 7. RLS and privileges

RLS is enabled on all four tables. `anon` and `authenticated` are revoked, then
re-granted narrowly:

```sql
grant select, insert, update on public.booking_statuses to authenticated;
grant select on public.booking_status_history to authenticated;
grant select on public.bookings to authenticated;
grant update (note, internal_note) on public.bookings to authenticated;
-- booking_counters: no grant at all.
```

**That column-level grant is the enforcement, not a convention.** Dates,
property, customer, status and price are *unreachable* through a plain UPDATE —
a client that skips the RPC gets a permission error from PostgreSQL, so there is
no path to a booking change that has not been through the lock and the conflict
scan. There is no INSERT policy on `bookings` either: `save_booking()` is the
only way a booking comes into existence.

| Policy                         | Rule                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `booking_statuses_select`      | `has_business_permission(business_id, 'bookings.manage')` — everyone on the team reads them; the calendar is coloured by them |
| `booking_statuses_insert`      | `is_system = false` **and** `bookings.statuses.manage` — a client cannot mint a built-in status |
| `booking_statuses_update`      | `bookings.statuses.manage`, in USING and WITH CHECK               |
| `bookings_select`              | `bookings.manage`                                                  |
| `bookings_update`              | `bookings.manage`, in USING and WITH CHECK (only the two note columns are grantable) |
| `booking_status_history_select`| `bookings.manage` — read-only history                              |

`booking_counters` has RLS on and **no policy**, which denies everything; only
`next_booking_number()` (definer) reaches it.

Two helper functions are revoked from `authenticated` outright, because they
answer questions about a property id without checking who is asking:
`booking_calculated_price()` and `next_booking_number()`. `booking_conflicts()`
is internal for the same reason — `check_booking_availability()` is the granted
wrapper that checks membership first.

### The six constraints this phase was asked to guarantee

1. **Users only reach bookings of businesses they are active members of** — every
   policy is `has_business_permission(business_id, …)`, which resolves the
   caller's *active* membership from `auth.uid()`.
2. **Customers and properties belong to the same business as the booking** —
   composite FKs, enforced by the schema, plus an explicit existence check per
   business inside `save_booking()`.
3. **A client-provided business id never bypasses membership validation** — the
   id is only ever an argument to a permission check, never a grant. A forged
   `p_business_id` fails `has_business_permission` for that business; it does not
   select a different tenant.
4. **One business's users never see or modify another's bookings or statuses** —
   asserted from *both* directions in `rls_bookings.sql` §8, against data that
   demonstrably exists on the other side.
5. **Conflict-override permission is checked server-side** — inside the RPC,
   after the lock, before the write. The UI check only decides whether to render
   the field.
6. **Booking numbers leak nothing cross-business** — the counter is keyed
   `(business_id, year)` and is unreadable to any client.

---

## 8. RPCs

All are `SECURITY DEFINER` with `set search_path = public, pg_temp`, revoked
from `public` and granted to `authenticated`, and all derive the caller from
`auth.uid()`.

| Function | Behaviour |
| -------- | --------- |
| `check_booking_availability(business, property, in, out, exclude?)` | read-only; needs `bookings.manage`; returns the conflict array for the form |
| `save_booking(business, property, customer, in, out, booking?, status?, source, note, internal_note, final_price?, price_reason?, conflict_override, conflict_reason?)` | create **and** edit; takes the advisory lock, validates the range, re-prices from the rate card, enforces cancel/restore/override permissions, writes the row and returns it |
| `set_booking_status(booking, status, conflict_override, conflict_reason?)` | the one-tap status change; re-runs the conflict scan when moving *back into* a blocking status, because the dates may have been given away |
| `resolve_pending_booking(booking, 'keep' \| 'release')` | needs `bookings.pending.resolve`; `keep` stamps the resolution, `release` cancels |

`save_booking` handles create and edit in one body on purpose — they share the
lock, the conflict scan, the price authority and the status permissions, so
splitting them would duplicate ~120 lines of guards for no behavioural
difference. It is marked with a `ponytail:` comment saying so.

### Error contract

The same one Phases 1–3 use, extended by one code:

| SQLSTATE | Meaning                                       |
| -------- | --------------------------------------------- |
| `28000`  | `auth_required`                                |
| `42501`  | `forbidden` (including every permission above) |
| `P0002`  | `booking_not_found`, `property_not_found`, `customer_not_found`, `status_not_found`, `pricing_not_found` |
| `22023`  | `invalid_range`, `invalid_price`, `invalid_action`, `property_unavailable`, `conflict_reason_required`, `price_reason_required` |
| `23P01`  | `booking_conflict`, with the conflict JSON array in DETAIL |

`bookingErrorKey()`, `conflictsFromError()` and `isOverridable()` in the shared
package map all of it to translation keys and to the override affordance, so
neither app parses SQL text of its own.

---

## 9. Shared package

Nothing in this phase's business logic exists twice.

| Module            | Adds in Phase 4                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `bookings.ts`     | `priceBooking`, `bookingDays`, `localDate`, `isWeekendDate`, `finalPrice`, `blocksDatesStatus`, `toOccupancy`, `statusLabel`, `findStatusByCode`, `isPendingExpired`, `pendingMinutesLeft`, `addMonths`, `monthGrid`, `weekGrid`, `coversDate`, `bookingSearchFilter`, `bookingErrorKey`, `conflictsFromError`, `isOverridable`, `BookingConflict` |
| `availability.ts` | `BookingOccupancy`, a `bookings` array and `excludeBookingId` on `AvailabilityInput`, `'booking'` added to `ConflictKind` |
| `schemas.ts`      | `bookingSchema` (including the quick-form path and the two override-reason refinements), `bookingStatusSchema`, `pendingResolutionSchema` |
| `constants.ts`    | `BOOKING_STATUS_CODES`, `BLOCKING_STATUS_CODES`, `blocksDates`, `DEFAULT_BOOKING_STATUSES`, `BOOKING_SOURCES`, `PENDING_EXPIRY_MINUTES`, `BOOKING_FILTERS`, `BOOKING_PAGE_SIZE`, `STATUS_COLORS` |
| `roles.ts`        | the six new permissions                                                                                  |
| `types.ts`        | `Booking`, `BookingStatus`, `BookingWithDetails`, `BookingStatusHistory`                                 |
| `i18n/`           | every `booking.*`, `calendar.*` and new `dashboard.*` key, in `en` and `km`                              |

Three worth calling out:

- **`statusLabel(status, t)`** translates a *seeded* status by its code, so a
  Khmer user does not read "Pending"; the moment an owner renames one, their
  wording wins. That beats adding a `name_km` column — rename the status to
  translate it.
- **`bookingSearchFilter(term, customerIds)`** builds the PostgREST `or=(…)`
  filter for booking number plus a pre-resolved customer id list. PostgREST
  cannot `or` across an embedded resource, so callers resolve matching customers
  first with `customerSearchFilter` (Phase 3) and pass the ids in — two round
  trips beats a database view that has to be kept in step with the search
  columns. Search by booking number, guest name and guest phone all work.
- **`coversDate(booking, day, tz)`** is what every calendar cell asks. Half-open,
  so a checkout day is free for the next guest, and a same-day stay still covers
  the one date it happens on.

---

## 10. Web (`apps/web`)

The Bookings and Calendar placeholders are gone.

| Route                          | What it is                                                                 |
| ------------------------------ | -------------------------------------------------------------------------- |
| `(app)/bookings/page.tsx`      | list: search (number / guest name / phone), property, status and date filters, all in `searchParams`; paginated |
| `(app)/bookings/new/page.tsx`  | create, including the quick path                                            |
| `(app)/bookings/[id]/page.tsx` | detail panel: facts, price breakdown, notes, status actions, conflict record, expired-hold review, duplicate-as-draft |
| `(app)/bookings/[id]/edit`     | edit dates, times, property, customer, status, price, notes                 |
| `(app)/bookings/statuses`      | status management — add, rename, recolour, reorder, disable                 |
| `(app)/calendar/page.tsx`      | **monthly and weekly** views, property filter, `view`/`date`/`propertyId` in `searchParams` |

Components in `src/components/bookings/`: `BookingForm`, `BookingActions`,
`StatusChip`, `StatusManager`. Data reads live in `src/lib/bookings.ts`;
mutations are Server Actions in `src/lib/actions/bookings.ts` returning the same
`ActionState` (`status`, `messageKey`, `fieldErrors`) as Phases 2–3, so error
text is always a translation key. Styling follows the existing design system —
modern SaaS, mostly rectangular, `rounded-sm`.

Calendar entries show the property, the guest, the status colour, the start and
end, and a conflict indicator when the booking was written over something.

The dashboard gains today's bookings, upcoming check-ins, upcoming checkouts,
pending bookings, expired holds and available properties. **No revenue totals.**

---

## 11. Mobile (`apps/mobile`)

Tabs are unchanged: Home, Properties, Calendar, Bookings, Customers, Settings.

| Route                       | What it is                                                                |
| --------------------------- | ------------------------------------------------------------------------- |
| `(tabs)/index.tsx`          | home: expired-hold banner and list, today, check-ins, checkouts, pending, available properties |
| `(tabs)/bookings.tsx`       | list with 300 ms debounced search, filter chips, property filter, "show more" |
| `(tabs)/calendar.tsx`       | month grid with a per-day count; tapping a day lists that day's stays      |
| `booking/new.tsx`           | quick booking; `?from=<id>` duplicates an existing booking as a draft      |
| `booking/[id]/index.tsx`    | detail, status change, complete / cancel / restore, expired-hold review    |
| `booking/[id]/edit.tsx`     | edit                                                                       |

`src/lib/bookings.ts` is the data layer; `src/components/BookingForm.tsx` is one
form shared by quick entry, full create and edit.

**Quick booking** is the Messenger/phone flow: property, guest, check-in,
check-out are required; price, source and note are optional; and a guest who is
not on file yet can be created **without leaving the screen** — the form inserts
the customer, then calls `save_booking` with the new id.

Notes on the deliberate simplifications:

- **Dates and times are four plain fields** (`YYYY-MM-DD` + `HH:MM`, numeric
  keyboard) rather than a native picker: no date-picker dependency is installed,
  the property's default check-in/checkout times are seeded automatically on
  selecting a property, and `localDateTimeSchema` in the shared package rejects
  anything malformed. Add a picker when a real user complains, not before.
- **The guest picker** is a search field over `ChoiceGroup`, showing the first 8
  matches — the existing radio component, not a new modal.
- Every screen renders loading, empty, validation-error, conflict, forbidden,
  success and network-error states.

---

## 12. Localization

No visible string is written inside a screen; every one is a `t('…')` key
present in both `en` and `km`. Two tests guard the pair: one fails if a Khmer
value is still the English string, another if a Khmer value contains no Khmer
codepoints. Validation messages are themselves keys, translated where they are
rendered.

Booking statuses translate through `statusLabel()` (§9). Money is formatted with
`formatMoney(locale, amount, currency)` and dates with
`formatDate`/`formatDateTime`, so KHR and Khmer numerals render correctly on
both platforms. Calendar month headings and weekday initials come from
`Intl.DateTimeFormat` with `km-KH` / `en-GB`.

---

## 13. Migrations added

| File                                | Contents                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `20260804001200_bookings.sql`       | `booking_status_code` enum, `booking_statuses`, `booking_counters`, `bookings`, `booking_status_history`, the seed trigger and back-fill, the system-status guard, `apply_booking_status()`, `log_booking_status()`, updated-at triggers, `booking_calculated_price()`, `next_booking_number()` |
| `20260804001300_bookings_rls.sql`   | the six new permissions, REVOKE/GRANT (including the column-level UPDATE grant), the six policies, and the revokes on the two internal helpers |
| `20260804001400_bookings_rpc.sql`   | `booking_conflicts()`, `check_booking_availability()`, `save_booking()`, `set_booking_status()`, `resolve_pending_booking()`, grants |

---

## 14. Deliberate omissions

- **No payments, receipts, OCR, invoices or revenue reports.** That is Phase 5.
  The dashboard deliberately shows no money.
- **No scheduled job.** Expired holds are detected at read time and surfaced
  prominently; §5 documents the recommended `pg_cron` shape for when
  notifications are wanted.
- **No room-level inventory.** Still one property, booked whole.
- **No recurring or group bookings**, no linked multi-property reservations.
- **No guest-facing anything.** No public booking form, no confirmation email,
  no customer login.
- **No booking deletion.** Cancel and restore; the row and its status history
  stay.
- **No automatic currency conversion.** `exchange_rate` is a column that Phase 5
  will populate; nothing converts today.
- **No seasonal pricing.** `property_pricing` is still keyed by `rule_type`, so
  it arrives as rows when it is needed.
- **No native date picker on mobile** (§11), and no drag-to-move on the web
  calendar — moving a booking is an edit, which is the path that re-checks
  conflicts.
