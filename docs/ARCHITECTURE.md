# Architecture

## Repository layout

```
homestay-saas/
├─ apps/
│  ├─ mobile/                 Expo SDK 57 + expo-router
│  │  ├─ app/                 file-based routes: (tabs)/, property/[id]/, customer/[id]/
│  │  └─ src/{lib,components}
│  └─ web/                    Next.js 16 App Router
│     └─ src/{app,components,lib}
│        ├─ app/(app)/properties/    list, new, [id], [id]/edit
│        ├─ app/(app)/guests/        list, new, [id], [id]/edit, import, export
│        ├─ components/properties/   PropertyForm, PricingForm, PhotoManager, BlockManager, PropertyStatusActions
│        ├─ components/customers/    CustomerForm, CustomerNotes, CustomerStatusActions, ImportWizard
│        └─ lib/{properties.ts, customers.ts, actions/{properties,customers}.ts}
├─ packages/shared/           types, zod schemas, roles, availability, i18n, formatting
├─ supabase/
│  ├─ migrations/             schema → functions → policies → RPCs, per phase
│  └─ tests/                  rls_isolation.sql, rls_properties.sql, rls_customers.sql, auth_stub.sql, smoke.mjs
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
| `constants.ts`   | locales, currencies, timezones, block reasons, `WEEKEND_DAYS`, photo bucket/mime/size limits, `propertyPhotoPath()`, `CUSTOMER_FILTERS`, `CUSTOMER_PAGE_SIZE`, `CUSTOMER_IMPORT_MAX_ROWS` |
| `availability.ts`| `checkAvailability`, `rangesOverlap`, `rateForNight`, `isWeekend`, `zonedTimeToUtc`, `utcToZonedInput` |
| `phone.ts`       | `normalizePhone`, `isNormalizedPhone`, `isValidPhone`, `CAMBODIA_CALLING_CODE` |
| `customers.ts`   | `customerSearchFilter`, `isSamePhone`, `duplicateRowIndexes`, `mapImportHeaders`, `parseCsv`, `parseCustomerCsv`, `toCsv` |
| `types.ts`       | `BusinessContext`, `Profile`, `Business`, `Property`, `Customer`, … mirroring the SQL types |

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
                      │                             └──< customers ──< customer_notes
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

All PKs are `uuid default gen_random_uuid()`. Every table has
`created_at`/`updated_at` and shares one `set_updated_at()` trigger function,
attached by a `do` block loop rather than nine copy-pasted `create trigger`
statements.

Enums (`business_role`, `member_status`, `app_locale`, `app_currency`,
`block_reason`, `block_status`, `pricing_rule_type`) are PostgreSQL enums, so an
invalid value cannot be stored even by a superuser.

**Children carry their own `business_id`.** `properties` declares
`unique (id, business_id)` and each child declares
`foreign key (property_id, business_id) references properties (id, business_id)
on delete cascade`. The database therefore guarantees a child's `business_id`
equals its parent's, which lets every child policy check membership directly
instead of joining up to the parent on every row. Properties are never hard
deleted — `archived_at` is the normal end state, so future booking history keeps
its foreign key.

## Authorization

Three layers, in order of authority:

**1. Privileges.** `anon` and `authenticated` are revoked on every tenant
table, then granted only what a policy could ever allow. `business_members`
has no INSERT/UPDATE/DELETE grant at all — membership only changes through an
RPC.

**2. RLS policies.** Enabled on `profiles`, `businesses`, `business_members`,
`business_settings`, `user_preferences`, `role_permissions`, `properties`,
`property_photos`, `property_pricing`, `property_blocks`, `customers`,
`customer_notes`, and on `storage.objects` for the photo bucket. Every policy
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

**3. SECURITY DEFINER functions**, all with `set search_path = public, pg_temp`:

| Function                            | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `current_role_in(business)`         | the caller's active role, or null               |
| `is_business_member(business)`      | membership predicate used by read policies      |
| `has_business_permission(b, perm)`  | joins `role_permissions`; used by write policies|
| `can_read_member_profile(user)`     | lets owners/managers read co-members' profiles  |
| `current_business_context()`        | resolves the business to show, with the role    |
| `can_access_property_object(k, p)`  | parses the tenant out of a storage object key, then defers to `has_business_permission` |

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

Archiving is the one property action a manager cannot perform — it is the
closest thing to a delete, so it stays with the owner.

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

Every one of them derives the actor from `auth.uid()` and re-reads the target
row inside the function. No RPC accepts a role or an actor id from the client.

**Storage.** Photos live in the private `property-photos` bucket under
`businesses/{businessId}/properties/{propertyId}/{fileName}`. All four object
policies run the key through `can_access_property_object()`, which takes the
second path segment as the tenant — a malformed or traversing key fails the
regex and is refused. Reads go through short-lived signed URLs; neither app ever
uses a service key. `docs/SUPABASE_SETUP.md` §3.7 has the bucket settings.

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

Phase 4 extends it by adding `'booking'` to `ConflictKind` and a `bookings`
array to `AvailabilityInput`. Everything already written keeps working, because
callers read the conflict list rather than reimplementing the rules.

## Web app

Next.js 16 App Router, React 19, Tailwind v4.

- `src/proxy.ts` — Next 16's renamed middleware. Calls `supabase.auth.getUser()`
  (not `getSession()`, which does not revalidate), redirects anonymous users to
  `/sign-in?next=…` and signed-in users away from the auth screens. This is the
  route guard; the layouts below are the second one.
- `(auth)/` — sign in, sign up, forgot password, reset password, verify.
- `(app)/` — layout calls `getBusinessContext()`; a user with no business is
  sent to `/onboarding`. Sidebar has all eight sections; Dashboard, Properties,
  Guests and Settings are real, the other four render the shared `Placeholder`.
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
