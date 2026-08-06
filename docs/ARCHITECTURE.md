# Architecture

## Repository layout

```
homestay-saas/
├─ apps/
│  ├─ mobile/                 Expo SDK 57 + expo-router
│  │  ├─ app/                 file-based routes: (tabs)/, property/[id]/, customer/[id]/, booking/[id]/, payment/[id], receipt/[id]
│  │  └─ src/{lib,components}
│  └─ web/                    Next.js 16 App Router
│     └─ src/{app,components,lib}
│        ├─ app/(app)/properties/    list, new, [id], [id]/edit
│        ├─ app/(app)/guests/        list, new, [id], [id]/edit, import, export
│        ├─ app/(app)/bookings/      list, new, [id], [id]/edit, statuses
│        ├─ app/(app)/calendar/      month and week views
│        ├─ app/(app)/payments/      list, [id]
│        ├─ app/(app)/receipts/[id]  printable receipt
│        ├─ components/properties/   PropertyForm, PricingForm, PhotoManager, BlockManager, PropertyStatusActions
│        ├─ components/customers/    CustomerForm, CustomerNotes, CustomerStatusActions, ImportWizard
│        ├─ components/bookings/     BookingForm, BookingActions, StatusChip, StatusManager
│        ├─ components/payments/     RecordPaymentForm, PaymentActions, PaymentSummary, BookingPayments, ProofManager, PrintButton
│        └─ lib/{properties.ts, customers.ts, bookings.ts, payments.ts, actions/{properties,customers,bookings,payments}.ts}
├─ packages/shared/           types, zod schemas, roles, availability, i18n, formatting
├─ supabase/
│  ├─ migrations/             schema → functions → policies → RPCs, per phase
│  └─ tests/                  rls_isolation.sql, rls_properties.sql, rls_customers.sql, rls_bookings.sql, rls_payments.sql, auth_stub.sql, smoke.mjs
└─ docs/
```

npm workspaces, no monorepo build tool. `@homestay/shared` publishes raw
TypeScript (`"main": "./src/index.ts"`); the web app compiles it through
`transpilePackages`, the mobile app through Metro `watchFolders`. Nothing to
build, nothing to keep in sync.

Imports inside `packages/shared` carry explicit `.ts` extensions
(`allowImportingTsExtensions`) so `node --test` can run the sources directly
using Node's native type stripping — the test suite needs zero dependencies.

## What lives in `packages/shared`

| Module           | Contents                                                            |
| ---------------- | ------------------------------------------------------------------- |
| `roles.ts`       | `Role`, `Permission`, `ROLE_PERMISSIONS`, `can`, `canManageMember`   |
| `schemas.ts`     | zod schemas for every form; messages are translation keys           |
| `i18n/`          | `en` and `km` dictionaries, `t()`, `resolveLocale`, `formatDate`, `formatMoney`, `toTimeInput` |
| `authErrors.ts`  | Supabase auth error code → translation key                          |
| `constants.ts`   | locales, currencies, timezones, block reasons, `WEEKEND_DAYS`, photo bucket/mime/size limits, `propertyPhotoPath()`, `CUSTOMER_FILTERS`, `CUSTOMER_PAGE_SIZE`, `CUSTOMER_IMPORT_MAX_ROWS`, `BOOKING_STATUS_CODES`, `BLOCKING_STATUS_CODES`, `blocksDates()`, `DEFAULT_BOOKING_STATUSES`, `BOOKING_SOURCES`, `PENDING_EXPIRY_MINUTES`, `BOOKING_FILTERS`, `BOOKING_PAGE_SIZE`, `STATUS_COLORS` |
| `availability.ts`| `checkAvailability`, `rangesOverlap`, `rateForNight`, `isWeekend`, `zonedTimeToUtc`, `utcToZonedInput` |
| `phone.ts`       | `normalizePhone`, `isNormalizedPhone`, `isValidPhone`, `CAMBODIA_CALLING_CODE` |
| `customers.ts`   | `customerSearchFilter`, `isSamePhone`, `duplicateRowIndexes`, `mapImportHeaders`, `parseCsv`, `parseCustomerCsv`, `toCsv` |
| `payments.ts`    | `round2`, `depositRequired`, `countsTowardBalance`, `sumPayments`, `bookingPaymentStatus`, `summarizeBookingPayments`, `isOverpayment`, `reachesDeposit`, `findDuplicates`, `isBlockingDuplicate`, `canOverride/Correct/Refund/Void/VerifyPayment`, `paymentErrorKey`, `duplicatesFromError`, `overpaymentFromError` |
| `bookings.ts`    | `priceBooking`, `bookingDays`, `finalPrice`, `localDate`, `isWeekendDate`, `blocksDatesStatus`, `toOccupancy`, `statusLabel`, `findStatusByCode`, `isPendingExpired`, `pendingMinutesLeft`, `addMonths`, `monthGrid`, `weekGrid`, `coversDate`, `bookingSearchFilter`, `bookingErrorKey`, `conflictsFromError`, `isOverridable` |
| `types.ts`       | `BusinessContext`, `Profile`, `Business`, `Property`, `Customer`, `Booking`, `BookingStatus`, `BookingWithDetails`, … mirroring the SQL types |

Both apps import from `@homestay/shared` only — neither app defines a role, a
permission or a user-facing string of its own.

## Data model

```
auth.users ──1:1── profiles
                      │
                      ├──< business_members >── businesses ──1:1── business_settings
                      │                             │
                      │                             ├──< properties ──< property_photos
                      │                             │            ├──< property_pricing
                      │                             │            └──< property_blocks
                      │                             ├──< customers ──< customer_notes
                      │                             ├──< booking_statuses
                      │                             ├──< booking_counters
                      │                             ├──< payment_counters, receipt_counters
                      │                             └──< bookings ──< booking_status_history
                      │                                      │
                      │                                      ├──< payments ──< payment_proofs
                      │                                      │        └──< payment_adjustments
                      │                                      └──< receipts
                      └──1:1── user_preferences ── last_business_id ─→ businesses
```

- `profiles` — display name, phone, avatar. Created by the `handle_new_user`
  trigger on `auth.users`, so a profile always exists.
- `businesses` — name, owner name, phone, currency, timezone, `created_by`,
  `deleted_at` (soft delete — a business is a tenant root, deleting it hard
  would orphan everything).
- `business_members` — `(business_id, user_id)` unique, `role`, `status`.
  Hard delete: a removed member is not history worth keeping in Phase 1.
- `business_settings` — per-business defaults, 1:1 with `businesses`.
- `user_preferences` — locale and `last_business_id`, which is what "open the
  most recently selected business" reads.
- `properties` — one row per rentable whole property: address, phone, map text,
  optional lat/long, default check-in/checkout times, `is_active`, `archived_at`,
  `cover_photo_id`. A booking will reserve the whole row; there is no room-level
  inventory.
- `property_photos` — one row per object in the private storage bucket, keyed by
  `storage_path`. The cover is a pointer on the parent, not a flag per photo.
- `property_pricing` — weekday/weekend price and currency per rule. Phase 2 only
  writes `rule_type = 'base'`; seasonal or per-date rules are extra rows, not a
  schema change.
- `property_blocks` — a manual unavailable range: `[starts_at, ends_at)`, a
  reason, an optional note, `created_by`, and `status` (`active`/`cancelled`),
  so cancelling keeps the audit trail.
- `customers` — a guest of one business. Full name and phone are the only
  required fields; `normalized_phone` and `normalized_phone_secondary` are
  **derived by a trigger** from the typed values, never accepted from a client,
  because they are what duplicate detection matches on. Guests never sign in;
  there is no `user_id` and no public route.
- `customer_notes` — internal staff notes, `archived_at` instead of a delete.
  Nothing here is rendered anywhere a guest can reach.
- `booking_statuses` — a per-business status list, seeded with Pending,
  Confirmed, Completed and Cancelled by an `after insert` trigger on
  `businesses`. Owners may rename, recolour, reorder and disable them; every
  rule in the system reads the immutable `code`, never the editable `name`.
- `bookings` — one stay of one whole property by one customer over
  `[check_in_at, check_out_at)`. Holds its own `booking_number`, currency,
  `calculated_price` **and** `final_price` (so a later price change never
  rewrites history), the price and conflict override fields with their reasons
  and approver, the source, both notes, and the pending-hold columns. The guest's
  name and phone are not copied here — they are read from `customers`.
- `booking_status_history` — who changed a booking's status and when, written by
  a definer trigger; nobody holds INSERT on it.
- `booking_counters` — `(business_id, year, last_number)`. No grants, no
  policies; only `next_booking_number()` touches it, and its per-business key is
  what keeps `BK-2026-000001` from leaking another tenant's volume.
  `payment_counters` and `receipt_counters` are the same table three times over.
- `payments` — one amount received (or refunded) against one booking. Carries its
  own `payment_number`, method, `payment_type`, `status`, the currency and
  `exchange_rate` **copied from the booking** so a later rate change cannot
  rewrite what was taken, the transaction reference, payer name, paid-at, the
  duplicate- and overpayment-override flags with their reasons, and who recorded
  and verified it. Nothing here is ever deleted: `status = 'voided'` is how a
  payment stops counting.
- `payment_proofs` — one row per screenshot or PDF in the private bucket, with
  its `storage_path`, mime, size and a `checksum` that is what "you already
  uploaded this file" matches on.
- `payment_adjustments` — the audit record for every void, correction and refund:
  the action, the reason, `amount_before`/`amount_after`, the actor, and for a
  refund a link to the new payment row it created. Insert-only, by definer
  functions; no client holds any grant.
- `receipts` — an issued receipt with its `receipt_number`, its language, and a
  `snapshot` jsonb holding every value it prints. The snapshot is why renaming a
  property next year does not change a receipt issued this year.

All PKs are `uuid default gen_random_uuid()`. Every table has
`created_at`/`updated_at` and shares one `set_updated_at()` trigger function,
attached by a `do` block loop rather than nine copy-pasted `create trigger`
statements.

Enums (`business_role`, `member_status`, `app_locale`, `app_currency`,
`block_reason`, `block_status`, `pricing_rule_type`, `booking_status_code`,
`payment_method`, `payment_type`, `payment_status`, `payment_adjustment_action`)
are PostgreSQL enums, so an invalid value cannot be stored even by a superuser.

**Children carry their own `business_id`.** `properties` declares
`unique (id, business_id)` and each child declares
`foreign key (property_id, business_id) references properties (id, business_id)
on delete cascade`. The database therefore guarantees a child's `business_id`
equals its parent's, which lets every child policy check membership directly
instead of joining up to the parent on every row. Properties are never hard
deleted — `archived_at` is the normal end state, so booking history keeps its
foreign key.

Bookings apply the same trick sideways rather than downwards: `property_id`,
`customer_id` and `status_id` are all **composite** foreign keys carrying
`business_id`, so a booking cannot reference another tenant's property, guest or
status even if a client asks it to. All three are `on delete restrict`, and
there is no DELETE grant on any booking table — cancellation is the end state.

Payments repeat both patterns at once. `payments` references
`(booking_id, business_id)` and `(customer_id, business_id)` compositely — the
requirement that a payment's booking, customer and business all agree is a
foreign key, not a check in application code — and `payment_proofs`,
`payment_adjustments` and `receipts` each reference `(payment_id, business_id)`
or `(booking_id, business_id)` the same way. Everything is `on delete restrict`,
and `authenticated` holds **no UPDATE and no DELETE on any of the four tables**,
which is the schema-level form of "do not permanently delete financial records".

## Authorization

Three layers, in order of authority:

**1. Privileges.** `anon` and `authenticated` are revoked on every tenant
table, then granted only what a policy could ever allow. `business_members`
has no INSERT/UPDATE/DELETE grant at all — membership only changes through an
RPC.

**2. RLS policies.** Enabled on `profiles`, `businesses`, `business_members`,
`business_settings`, `user_preferences`, `role_permissions`, `properties`,
`property_photos`, `property_pricing`, `property_blocks`, `customers`,
`customer_notes`, `booking_statuses`, `bookings`, `booking_status_history`,
`booking_counters`, `payments`, `payment_proofs`, `payment_adjustments`,
`receipts`, `payment_counters`, `receipt_counters`, and on `storage.objects` for
both private buckets. Every policy
resolves the caller from `auth.uid()`; a client-supplied `business_id` is only
ever a filter, never a grant. Reads are scoped by `is_business_member()`, writes
by `has_business_permission()`. Archived properties are filtered out by the
`properties` read policy itself, so nothing downstream has to remember to
exclude them.

Customers are the deliberate exception: the read policy **keeps** archived rows,
because the list has an archived filter, restoring has to read the row first,
and duplicate detection must still see a number that belongs to an archived
guest. Read-only-ness comes from the update policy instead, which repeats
`archived_at is null` in both USING and WITH CHECK — so a plain `UPDATE` can
neither edit an archived customer nor archive a live one. Archiving is only
`set_customer_archived()`.

Bookings go one step further, because a date change has to be transaction-safe:
`authenticated` gets `select` on `bookings` and a **column-level**
`update (note, internal_note)`, and no INSERT policy at all. Dates, property,
customer, status and price are therefore unreachable outside `save_booking()` —
there is no code path to a booking change that has not been through the advisory
lock and the conflict scan. `booking_counters` has RLS on and no policy, which
denies everything.

Payments go furthest of all: `authenticated` gets `select` on `payments`,
`payment_adjustments` and `receipts`, `select` **and** `insert` on
`payment_proofs` (uploading evidence is the one thing a client does directly),
and nothing else. Every amount, status and reason is written by a definer RPC.
`payment_counters` and `receipt_counters` are RLS-on-no-policy like their booking
sibling.

**3. SECURITY DEFINER functions**, all with `set search_path = public, pg_temp`:

| Function                            | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `current_role_in(business)`         | the caller's active role, or null               |
| `is_business_member(business)`      | membership predicate used by read policies      |
| `has_business_permission(b, perm)`  | joins `role_permissions`; used by write policies|
| `can_read_member_profile(user)`     | lets owners/managers read co-members' profiles  |
| `current_business_context()`        | resolves the business to show, with the role    |
| `can_access_property_object(k, p)`  | parses the tenant out of a storage object key, then defers to `has_business_permission` |
| `can_access_payment_object(k, p)`   | the same, for the `payment-proofs` prefix     |
| `booking_payment_summary(booking)`  | one row of totals for a booking, membership-gated inside the function |

The permission matrix itself is a table (`role_permissions`), seeded in the
migration. Policies join it, so adding a permission is a data change, not a
policy rewrite. Phase 2 added six rows' worth of permissions:

| Permission                  | owner | manager | staff |
| --------------------------- | :---: | :-----: | :---: |
| `properties.read`           |  ✓    |   ✓     |  ✓    |
| `properties.manage`         |  ✓    |   ✓     |       |
| `properties.pricing.manage` |  ✓    |   ✓     |       |
| `properties.photos.manage`  |  ✓    |   ✓     |       |
| `properties.blocks.manage`  |  ✓    |   ✓     |       |
| `properties.archive`        |  ✓    |         |       |
| `customers.manage`          |  ✓    |   ✓     |  ✓    |
| `customers.archive`         |  ✓    |   ✓     |       |
| `customers.notes.manage`    |  ✓    |   ✓     |       |
| `customers.import`          |  ✓    |   ✓     |       |
| `customers.export`          |  ✓    |   ✓     |       |
| `bookings.manage`           |  ✓    |   ✓     |  ✓    |
| `bookings.statuses.manage`  |  ✓    |         |       |
| `bookings.conflict.override`|  ✓    |   ✓     |       |
| `bookings.price.override`   |  ✓    |   ✓     |       |
| `bookings.cancel`           |  ✓    |   ✓     |       |
| `bookings.restore`          |  ✓    |         |       |
| `bookings.pending.resolve`  |  ✓    |   ✓     |       |
| `payments.manage`           |  ✓    |   ✓     |  ✓    |
| `payments.verify`           |  ✓    |   ✓     |       |
| `payments.correct`          |  ✓    |   ✓     |       |
| `payments.refund`           |  ✓    |   ✓     |       |
| `payments.override`         |  ✓    |   ✓     |       |
| `payments.void`             |  ✓    |         |       |
| `receipts.manage`           |  ✓    |   ✓     |       |

Archiving is the one property action a manager cannot perform — it is the
closest thing to a delete, so it stays with the owner. Restoring a cancelled
booking is the booking equivalent: it is the one action that can take dates back
from whoever was given them after the cancellation.

**RPCs for anything multi-step:**

| RPC                          | Guard                                                        |
| ---------------------------- | ------------------------------------------------------------ |
| `create_business(...)`       | caller becomes `owner`; creates business + settings + membership + updates `last_business_id` atomically |
| `set_member_role(...)`       | owners only; cannot target yourself; cannot act cross-tenant  |
| `remove_member(...)`         | managers may remove staff; only owners may remove managers; the last owner cannot be removed |
| `soft_delete_business(...)`  | owners only                                                   |
| `create_property(...)`       | needs `properties.manage`; creates the property and its base pricing row in one transaction, defaulting currency to the business setting |
| `set_property_archived(...)` | needs `properties.archive`; also forces `is_active = false`   |
| `set_property_cover_photo(...)` | needs `properties.photos.manage`; refuses a photo that belongs to another property |
| `set_customer_archived(...)` | needs `customers.archive`; the only way `archived_at` ever changes |
| `import_customers(...)`      | needs `customers.import`; caps the batch at 500 rows and returns one `imported`/`duplicate`/`invalid` outcome per row — no partial silent failure |
| `export_customers(...)`      | needs `customers.export`, so staff cannot bulk export; scoped to one business, with archived and search filters |
| `check_booking_availability(...)` | needs `bookings.manage`; read-only, returns the conflict array the form shows |
| `save_booking(...)`          | create **and** edit in one body; takes `pg_advisory_xact_lock` on the property, re-scans conflicts, re-prices from the rate card, and enforces the conflict, price, cancel and restore permissions before writing |
| `set_booking_status(...)`    | needs `bookings.manage`; re-runs the conflict scan when moving back into a status that holds dates |
| `resolve_pending_booking(...)` | needs `bookings.pending.resolve`; `keep` stamps the resolution, `release` cancels — nothing expires a booking automatically |
| `payment_duplicates(...)`    | read-only; returns the reference, same-amount-within-30-minutes and file-checksum matches the form warns on |
| `record_payment(...)`        | needs `payments.manage`; copies business, customer, currency and rate from the booking, blocks a duplicate reference and an overpayment unless the caller has `payments.override` **and** gives a reason, then calls `confirm_on_deposit` |
| `verify_payment(...)`        | needs `payments.verify`                                       |
| `void_payment(...)`          | needs `payments.void` (owner only) and a reason; sets the status, writes the adjustment, keeps the row |
| `correct_payment(...)`       | needs `payments.correct` and a reason; re-checks the overpayment ceiling, clears the verification, records both amounts |
| `refund_payment(...)`        | needs `payments.refund` and a reason; creates a `refund` payment row rather than editing the original |
| `issue_receipt(...)`         | needs `receipts.manage`; takes the number from `receipt_counters` and freezes every printed value into `snapshot` |

Every one of them derives the actor from `auth.uid()` and re-reads the target
row inside the function. No RPC accepts a role or an actor id from the client.
The payment RPCs never accept a `business_id` at all — they take a booking or a
payment id and read the tenant off the row, so there is nothing for a client to
forge. `confirm_on_deposit` is internal and revoked from `authenticated`.

**Storage.** Photos live in the private `property-photos` bucket under
`businesses/{businessId}/properties/{propertyId}/{fileName}`. All four object
policies run the key through `can_access_property_object()`, which takes the
second path segment as the tenant — a malformed or traversing key fails the
regex and is refused. Reads go through short-lived signed URLs; neither app ever
uses a service key. `docs/SUPABASE_SETUP.md` §3.7 has the bucket settings.

Payment proofs live in a second private bucket, `payment-proofs`, under
`businesses/{businessId}/payments/{paymentId}/{fileName}`, with the same
prefix-parsing helper and the same signed-URL reads. It differs in two ways:
`application/pdf` is allowed, because bank transfer receipts arrive as PDFs, and
there is no update or delete policy at all. §3.10 has the settings.

## The permission matrix exists twice, on purpose

SQL `role_permissions` is the enforcement. TypeScript `ROLE_PERMISSIONS` is
what the UI reads to decide whether to render a button. They are kept honest by
`packages/shared/src/roles.test.ts`, which parses both permission migrations and
fails if the two drift. Hiding a button is never the check — the database
refuses the write regardless.

## Availability

`packages/shared/src/availability.ts` is the single answer to "can this property
be occupied over this range". It is pure: it takes the property, its blocks and
a range, and returns `{available, conflicts[]}` — a list, not a boolean, so a
caller can say *why*.

Ranges are half-open `[start, end)`, so a checkout at 12:00 and a check-in at
12:00 do not collide. Wall-clock input is converted with `zonedTimeToUtc()`,
which resolves the offset from `Intl` in two passes — no date library. Weekend
is Friday, Saturday and Sunday (`WEEKEND_DAYS`) evaluated in the business
timezone, defaulting to `Asia/Phnom_Penh`.

Phase 4 extended it by adding `'booking'` to `ConflictKind`, a `bookings` array
and an `excludeBookingId` to `AvailabilityInput` — so a booking being edited does
not conflict with itself. Everything already written kept working, because
callers read the conflict list rather than reimplementing the rules.

The database mirror is `booking_conflicts()`, using `tstzrange(a, b, '[)') &&`
so the two agree on adjacency, and it is what `save_booking()` and
`set_booking_status()` consult **inside the transaction, after taking the lock**.
The TypeScript version drives the live warning in the form; the SQL version is
the rule. `booking_calculated_price()` is the same arrangement for pricing: the
apps preview with `priceBooking()`, the database recomputes and stores its own
number, and only an authorized `p_final_price` with a reason changes the total.

## Money

There is no stored balance column anywhere. Every total is derived from the
payment rows each time it is asked for, by the same arrangement as availability:
`packages/shared/src/payments.ts` for the preview, SQL for the answer.

`booking_payment_totals` is a `security_invoker` view that sums non-voided
payments per booking, and `booking_payment_summary(booking_id)` is the definer
function the apps and the RPCs both call — it re-checks membership itself, so it
is safe to expose and impossible to aim at another tenant.
`summarizeBookingPayments()` is the TypeScript mirror, kept honest by
`payments.test.ts`.

Voided rows are what stop counting; unverified ones still do. Verification
records that someone confirmed the money arrived — it is not a gate on the
arithmetic, because a booking whose balance silently ignored an unverified
deposit would show the guest as unpaid on arrival.

A refund is its own row (`payment_type = 'refund'`, positive amount), never an
edit of the payment it reverses, so `total_paid` keeps the history and `net_paid`
carries the truth. `deposit_required` is 50% of the booking total, rounded once
at the end. Currency and `exchange_rate` are copied onto each payment from the
booking, so a rate change tomorrow cannot rewrite what was taken today.

## Web app

Next.js 16 App Router, React 19, Tailwind v4.

- `src/proxy.ts` — Next 16's renamed middleware. Calls `supabase.auth.getUser()`
  (not `getSession()`, which does not revalidate), redirects anonymous users to
  `/sign-in?next=…` and signed-in users away from the auth screens. This is the
  route guard; the layouts below are the second one.
- `(auth)/` — sign in, sign up, forgot password, reset password, verify.
- `(app)/` — layout calls `getBusinessContext()`; a user with no business is
  sent to `/onboarding`. Sidebar has all eight sections; only Reports still
  renders the shared `Placeholder`.
- `(app)/properties/` — a card grid with server-side search (name and address)
  and an active/inactive filter, both held in `searchParams` so the URL is
  shareable and the back button works; `new`, `[id]` and `[id]/edit`. The detail
  page composes `PricingForm`, `PhotoManager`, `BlockManager` and
  `PropertyStatusActions`, each of which renders read-only for staff.
- `(app)/guests/` — the customer section: a paginated table with server-side
  search and an active/archived/all filter, both in `searchParams`; `new`,
  `[id]`, `[id]/edit`, an `import` wizard that previews and classifies every CSV
  row before writing anything, and an `export` route handler that re-checks
  `customers.export` server-side before streaming CSV.
- `(app)/bookings/` — a paginated list with search over booking number, guest
  name and guest phone plus property, status and date filters, all in
  `searchParams`; `new`, `[id]`, `[id]/edit` and a `statuses` screen for the
  owner. The detail page composes the price breakdown, notes, `BookingActions`,
  the conflict record and the expired-hold review.
- `(app)/calendar/` — month and week views over the same data, with a property
  filter; `view`, `date` and `propertyId` live in `searchParams`.
- `(app)/payments/` — a paginated list with search over payment number,
  reference, guest name, guest phone and booking number plus status, method,
  property and date-range filters, all in `searchParams`; `[id]` is the detail
  page with the audit trail, the proof gallery and the role-gated actions.
  Recording a payment happens on the booking, where the amount owed is, not on a
  separate screen that would have to ask which booking.
- `(app)/receipts/[id]` — a print-styled page rendered entirely from the stored
  snapshot, in the language the receipt was issued in. `PrintButton` calls
  `window.print()`; a `@media print` block drops the chrome.
- All mutations are Server Actions returning a common `ActionState`
  (`status`, `messageKey`, `fieldErrors`) that the client forms render through
  `useActionState`. Error text is always a translation key, never a string.
- `auth/callback/route.ts` exchanges the OAuth/PKCE code and only accepts a
  same-origin `next` path.

## Mobile app

Expo SDK 57, expo-router, React Native 0.86.

- `src/lib/supabase.ts` — client with `AsyncStorage`, `persistSession`,
  `autoRefreshToken`, plus `AppState` listeners so refresh stops in background.
- `src/lib/session.tsx` — one `SessionProvider` holding `user`, `business`,
  `locale` and two readiness flags. `app/index.tsx` is the gate: not ready →
  spinner, no user → `/sign-in`, no business → `/onboarding`, else `/(tabs)`.
- OAuth uses `expo-auth-session` + `expo-web-browser`, parses the `code` out of
  the deep link and calls `exchangeCodeForSession`.
- Tabs: Home, Properties, Calendar, Bookings, Customers, Settings.
- `app/property/[id]/`, `app/property/new` — detail, edit and create, sharing
  `PropertyForm`, `PhotoManager` and `BlockManager` from `src/components`. The
  list reloads on focus (`useFocusEffect`), so an edit is visible on the way
  back without a manual refresh.
- `app/booking/[id]/`, `app/booking/new` — detail, edit and create, sharing one
  `BookingForm` between quick entry, full create and edit. `new?from=<id>`
  duplicates an existing booking as a draft. The quick form is the
  Messenger/phone flow: property, guest and both dates required, price, source
  and note optional, and a guest who is not on file can be created without
  leaving the screen.
- `(tabs)/calendar.tsx` — a month grid with a per-day count; tapping a day lists
  that day's stays. `(tabs)/index.tsx` is the dashboard: today, check-ins,
  checkouts, pending and expired holds, available properties, and — since Phase 5
  — unpaid bookings, pending deposits, balance due and paid today.
- `app/booking/[id]/payment.tsx`, `app/payment/[id].tsx`, `app/receipt/[id].tsx`
  — the booking screen carries the summary, the history and the receipts
  (`BookingPayments`, `PaymentSummary`); recording is one screen reached from the
  booking, and a receipt shares as text through the system share sheet. Proofs
  are picked with `expo-image-picker` and uploaded exactly like property photos.
- `app/customer/[id]/`, `app/customer/new` — the same shape for customers,
  sharing `CustomerForm` and `CustomerNotes`. Search is debounced 300 ms with a
  plain `setTimeout` effect, and pagination grows `range(0, page * PAGE_SIZE)`
  fetching one extra row to answer "is there more?" without a count query.
- Photos are picked with `expo-image-picker`, read as bytes with
  `expo-file-system`'s `new File(uri).bytes()`, and uploaded with the user's own
  session — no base64 round trip, which matters because the mobile tsconfig has
  no DOM lib and therefore no `atob` or `crypto.randomUUID`. Object names come
  from `expo-crypto`'s `randomUUID()`, never from the picked file name: the name
  becomes the storage key, and the key is what the policies parse.

## Localization

Flat key dictionaries in `packages/shared/src/i18n`. No visible string is
written inside a screen; components call `t('key')`. zod validation messages
are themselves keys, so a field error is translated when it is rendered rather
than when it is thrown.

The chosen locale is written to `user_preferences.locale` (the durable copy,
protected by RLS to the caller's own row) and mirrored to a cookie on the web
and to AsyncStorage on mobile, which is what each app actually reads at render
time. `resolveLocale()` falls back to `en` for anything it does not recognise,
so a tampered cookie cannot break rendering.

Khmer renders through a font stack rather than bundled font files: the web
links Inter + Noto Sans Khmer from Google Fonts and falls back to the OS Khmer
faces, and mobile uses the system Khmer font. A test asserts every Khmer value
actually contains Khmer codepoints, which catches copy-paste-the-English
mistakes.

## Deliberate omissions

Phase 1:

- No generated Supabase types — that needs a live project. Exactly two casts
  exist, both commented, in `apps/web/src/lib/business.ts`.
- No `expo-apple-authentication`; the web OAuth flow serves both providers.
- Mobile password reset hands off to the web app's `/reset-password`.
- No invitation flow — the owner is created by `create_business`; other members
  are seeded by a privileged operator.

Phase 2:

- No room-level inventory. A property is the unit that gets booked.
- No seasonal, per-date or length-of-stay pricing. `property_pricing` is keyed
  by `rule_type` so those arrive as rows, not as a migration of the model.
- No image resizing, thumbnails or EXIF stripping — the bucket caps size and
  MIME type, and photos are served through signed URLs at their original size.
- No calendar view. Blocks are a list; the calendar belongs with bookings.
- No bulk actions, CSV import or property duplication.

Phase 3:

- No booking or payment tables. The customer's history section is an empty
  state; placeholder rows would only teach staff to distrust the screen.
- No merge tool and no name-based matching. Duplicate detection warns by phone
  and links to the existing record; a human decides. Two records are
  recoverable, a wrong merge is not.
- No hard delete and no dev-only purge utility. If one is ever added it stays
  server-side and disabled in production.
- No note authorship on mobile — the app has no member directory yet.
- No customer tags, segments, loyalty or marketing consent.
- Import is CSV only; no Excel binary formats.

Phase 4:

- No payments, receipts, OCR, invoices or revenue reports. The dashboard
  deliberately shows counts and no totals.
- No scheduled job for pending holds. Expiry is detected at read time and
  surfaced prominently; `docs/PHASE_4_BOOKINGS.md` §5 documents the recommended
  `pg_cron` shape, and that job must notify rather than cancel.
- No automatic currency conversion. `bookings.exchange_rate` is a column Phase 5
  will populate.
- No recurring, group or multi-property bookings.
- No booking deletion — cancel and restore; the row and its status history stay.
- No native date picker on mobile and no drag-to-move on the web calendar; moving
  a booking is an edit, which is the path that re-checks conflicts.

Phase 5:

- No OCR. A proof is stored, shown and checksummed; nothing reads the amount out
  of it. That is Phase 6, and `payment_proofs` already has the columns for it.
- No PDF or image export of a receipt. Print works on the web, and mobile shares
  text; a rendering pipeline is a dependency Phase 5 did not need.
- No PDF proof upload from mobile — `expo-image-picker` offers images only. The
  bucket and the web dashboard both accept PDFs.
- No payment gateway. ABA and KHQR are recorded as methods, not integrated; the
  guest pays through Messenger and someone types the amount in.
- No revenue reports, no subscriptions, no platform billing. `/reports` is still
  a placeholder.
- No partial refunds against a specific proof, no multi-currency settlement, and
  no automatic exchange-rate lookup — the booking's snapshot is copied forward.
- No scheduled reminder for an unpaid balance.
