# Phase 2 — properties, pricing, availability, staff access

Phase 2 adds the thing the business actually rents: a **property**. A property
is an entire building — a homestay, a villa, a small resort. A booking (Phase 4)
will reserve all of it, so there is deliberately **no room-level inventory**
anywhere in this schema.

Still out of scope: customers, bookings, payments, OCR, reports, subscriptions,
and any public guest-facing page.

---

## 1. Data model

```
businesses ──< properties ──< property_photos      (metadata; bytes in Storage)
                         ├──< property_pricing     (one 'base' rule today)
                         └──< property_blocks      (manual unavailability)
```

Every child table carries `business_id` **and** `property_id`, and the FK is
composite:

```sql
foreign key (property_id, business_id)
  references public.properties (id, business_id) on delete cascade
```

That is what makes `business_id` trustworthy on a child row. A policy can read
the column directly instead of joining back to `properties`, and the database
guarantees the two cannot drift — a photo can never be filed under one tenant
while pointing at another tenant's property.

### `properties`

| Column                                        | Notes                                             |
| --------------------------------------------- | ------------------------------------------------- |
| `id`, `business_id`                            | uuid PK; `unique (id, business_id)` for the composite FK |
| `name`                                         | 2–120 chars after trim                            |
| `address`, `description`, `phone`, `map_location` | all optional, length-checked                   |
| `latitude`, `longitude`                        | `numeric(9,6)`, range-checked, optional           |
| `default_check_in_time`, `default_check_out_time` | `time`, default `14:00` / `12:00`              |
| `is_active`                                    | operator toggle — visible but unavailable         |
| `archived_at`                                  | soft delete; set only by `set_property_archived()` |
| `created_by`, `created_at`, `updated_at`       | audit                                             |

Two live properties in one business may not share a name
(`properties_business_name_key`, a partial unique index on
`lower(btrim(name)) where archived_at is null`). Archiving frees the name.

**Properties are never hard-deleted.** There is no `DELETE` grant on the table
at all, because Phase 4 bookings will reference these rows. Archiving is the
delete button, and archiving also forces `is_active = false` so a restored
property cannot come back silently bookable.

### `property_pricing`

`weekday_price`, `weekend_price`, `currency` (`USD` or `KHR`), plus a
`rule_type` enum whose only value today is `'base'`. A partial unique index
allows exactly one base row per property.

That discriminator is the extension point. A seasonal or event rate becomes a
**new row** with a new `rule_type` value and a date range — no change to
`properties`, no rewrite of the read path, no migration of existing prices.

Weekend means **Friday, Saturday and Sunday**. That definition lives in exactly
one place, `isWeekend()` in `packages/shared/src/availability.ts`, and is
evaluated in the business timezone, not the server's.

> PostgREST serialises `numeric` as a JSON **number**, so `PropertyPricing`
> types both prices as `number`. `db:smoke` asserts it — if that ever changes,
> money formatting would otherwise degrade silently.

### `property_photos`

Metadata only. The bytes live in the private `property-photos` bucket and the
row points at them through `storage_path` (unique). `mime_type` is constrained
to `image/jpeg`, `image/png`, `image/webp`; `size_bytes` to 10 MB. A partial
unique index enforces one cover photo per property, which is why setting a
cover is an RPC — two statements have to run between index checks.

### `property_blocks`

Manual unavailability: `starts_at`, `ends_at`, `reason`
(`maintenance | owner_use | renovation | custom`), optional `note`, `created_by`,
and `status` (`active | cancelled`).

Ranges are **half-open** — `[starts_at, ends_at)` — and
`check (ends_at > starts_at)` rejects an inverted or zero-length range in the
database, not just in the form. Blocks are cancelled, never deleted (no `DELETE`
grant), so "why was this property unavailable in March" stays answerable.

---

## 2. Permissions

Phase 1's permission matrix is a table (`role_permissions`) joined by
`has_business_permission(business_id, permission)`. Phase 2 adds rows to it —
no new mechanism.

| Permission                  | Owner | Manager | Staff |
| --------------------------- | :---: | :-----: | :---: |
| `properties.read`           |  ✅   |   ✅    |  ✅   |
| `properties.manage`         |  ✅   |   ✅    |  —    |
| `properties.pricing.manage` |  ✅   |   ✅    |  —    |
| `properties.photos.manage`  |  ✅   |   ✅    |  —    |
| `properties.blocks.manage`  |  ✅   |   ✅    |  —    |
| `properties.archive`        |  ✅   |   —     |  —    |

Read as prose: **owner** does everything; **manager** creates, edits, activates,
prices, photographs and blocks; **staff** reads property information and
availability and nothing else. Staff cannot delete properties, cannot change
pricing, cannot touch business settings and cannot manage roles.

The same matrix exists in TypeScript (`packages/shared/src/roles.ts`) purely so
the UI can decide whether to render a button. `roles.test.ts` parses the
migration and fails if the two drift. **Hiding a button is never the check** —
every screen's action goes through a server action or RPC that calls
`has_business_permission()` again, and behind that an RLS policy that checks a
third time.

---

## 3. Row-level security

RLS is enabled on all four tables, `anon` and `authenticated` are revoked, then
re-granted only what a policy could ever allow:

| Table              | SELECT | INSERT | UPDATE | DELETE |
| ------------------ | :----: | :----: | :----: | :----: |
| `properties`       |   ✅   |   ✅   |   ✅   |   —    |
| `property_pricing` |   ✅   |   ✅   |   ✅   |   —    |
| `property_photos`  |   ✅   |   ✅   |   ✅   |   ✅   |
| `property_blocks`  |   ✅   |   ✅   |   ✅   |   —    |

Photos are the one thing really deleted: the storage object goes with the row
and there is no history worth keeping in a thumbnail.

Notable policy details:

- **A client-supplied `business_id` buys nothing.**
  `has_business_permission()` resolves the caller's role from `auth.uid()` for
  exactly that business. Forging an id just means you are not a member of it.
- `properties_select` filters `archived_at is null`, so an archived property
  disappears from every read path at once.
- `properties_update` repeats `archived_at is null` in **both** `USING` and
  `WITH CHECK`, which makes archiving unreachable through a plain `UPDATE`.
  `set_property_archived()` is the only path, and it needs `properties.archive`.
- `created_by` may only ever be `auth.uid()`, on properties, photos and blocks.
- `property_photos_insert` additionally requires the row to describe an object
  inside its own prefix:
  `storage_path like 'businesses/{business_id}/properties/{property_id}/%'`.

### RPCs

| RPC                                       | Guard                                                     |
| ----------------------------------------- | --------------------------------------------------------- |
| `create_property(...)`                    | `properties.manage`; creates the property **and** its base pricing row in one transaction — a property with no rate should not be storable. Currency falls back to the business default. |
| `set_property_archived(id, archived)`     | `properties.archive` (owner only); also clears `is_active` |
| `set_property_cover_photo(photo_id)`      | `properties.photos.manage`; clears the old cover and sets the new one between index checks |

Each is `SECURITY DEFINER` with `set search_path = public, pg_temp` and
re-derives the caller from `auth.uid()`, exactly like the Phase 1 RPCs.

---

## 4. Storage

Bucket **`property-photos`**, created by
`20260804000800_property_storage.sql`:

- **private** — `public = false`. No unauthenticated read, ever. Images are
  served through short-lived signed URLs (10 minutes) minted server-side.
- `file_size_limit = 10485760` (10 MB) and
  `allowed_mime_types = {image/jpeg, image/png, image/webp}` are set on the
  bucket, so Storage itself refuses an oversized or non-image upload even if a
  forged client skips the app-level check.

Object keys are:

```
businesses/{businessId}/properties/{propertyId}/{uuid}.{ext}
```

The file name is **always** a generated UUID, never the picked file's name: the
key is what the storage policies parse, so it must not be attacker-controlled.

All four `storage.objects` policies call one helper:

```sql
public.can_access_property_object(name, permission)
```

which regex-validates the key layout, extracts element 2 as the tenant id, and
defers to `has_business_permission()`. Same permission matrix as every table —
not a second, drifting copy. A malformed key returns `false` rather than
raising. SELECT needs `properties.read`; INSERT/UPDATE/DELETE need
`properties.photos.manage`, so staff can view photos but not upload or remove
them.

The whole migration is wrapped in a guard on the `storage` schema existing, so
the SQL suites can still run against bare PostgreSQL.

### Upload flow (both apps)

1. Validate mime type and byte length client-side (`PHOTO_MIME_TYPES`,
   `PHOTO_MAX_BYTES`).
2. Upload to `propertyPhotoPath({ businessId, propertyId, fileName })`.
3. Insert the `property_photos` row. **If the insert fails, the object is
   removed again** — an orphaned object with no row would be invisible and
   unbillable-to-nobody forever.
4. Deleting reverses it: remove the object first, bail if that errored, then
   delete the row and promote the next photo to cover via the RPC.

---

## 5. Availability service

`packages/shared/src/availability.ts`, shared by both apps and by whatever
Phase 4 adds.

```ts
checkAvailability({ property, blocks, startsAt, endsAt, timeZone })
  → { available: boolean; conflicts: AvailabilityConflict[] }
```

Conflict kinds today: `invalid_range`, `property_archived`, `property_inactive`,
`block`. Phase 4 adds `booking` to that union and passes bookings alongside
blocks — **the function is extended, not replaced**, because it already returns
a list of conflicts from a list of ranges rather than a boolean from one source.

Supporting exports: `rangesOverlap`, `isPropertyBookable`, `isWeekend`,
`rateForNight`, `zonedTimeToUtc`, `utcToZonedInput`.

Timezone handling is dependency-free: `zonedTimeToUtc()` does a two-pass `Intl`
offset resolution, so `2026-09-11T14:00` in `Asia/Phnom_Penh` becomes the right
instant without pulling in a date library. Blocks are stored as `timestamptz`
(instants); forms collect wall-clock time and convert at the boundary.

Ranges are half-open, so a block ending at 12:00 and one starting at 12:00 are
**adjacent, not overlapping**. `availability.test.ts` asserts that explicitly.

---

## 6. Screens

### Web (`apps/web`)

| Route                      | What it does                                                     |
| -------------------------- | ---------------------------------------------------------------- |
| `/properties`              | card grid, cover photos, search box, active/inactive filter       |
| `/properties/new`          | create form (details + opening prices)                            |
| `/properties/[id]`         | details, pricing, photo manager, block manager, activate/archive  |
| `/properties/[id]/edit`    | edit form                                                         |

Search and filter are a plain `<form method="get">` — the query string is the
state, so results are shareable and the back button works. All mutations are
Server Actions returning the Phase 1 `ActionState`.

Components: `PropertyForm`, `PricingForm`, `PhotoManager`, `BlockManager`,
`PropertyStatusActions` (the last one exists so `window.confirm` can wrap
archiving from a server-rendered page).

### Mobile (`apps/mobile`)

| Route                     | What it does                                          |
| ------------------------- | ----------------------------------------------------- |
| `(tabs)/properties`       | list, search, filter chips, reloads on focus          |
| `property/new`            | create                                                |
| `property/[id]`           | details, inline pricing, photos, blocks, archive      |
| `property/[id]/edit`      | edit                                                  |

`src/lib/properties.ts` is the mobile data layer — the same reads and writes as
the web server actions, client-side, every call scoped by `business_id` on top
of RLS.

Photo picking uses `expo-image-picker` (permission requested, denial surfaced as
a translated banner), bytes are read with `expo-file-system`'s
`new File(uri).bytes()`, and the object key uses `expo-crypto`'s `randomUUID()`
— Hermes has no `crypto.randomUUID`.

Date/time entry for blocks is four numeric fields (date + time per bound) rather
than a picker dependency, joined and validated by the same
`propertyBlockSchema` the web uses.

Every screen has explicit loading, empty, error/retry, upload-progress,
validation-error and success states.

### Localization

Every new string is a key in `packages/shared/src/i18n/{en,km}.ts` —
`property.*`, `pricing.*`, `photo.*`, `block.*`. No visible text is written
inline in a screen. Two tests guard it: one fails if a Khmer value is still the
English string, another fails if a Khmer value contains no Khmer codepoints.

The one exception is the iOS/Android photo-library permission string in
`app.config.ts`: native permission copy lives in the manifest and cannot come
from the dictionary. The in-app copy around it is translated.

---

## 7. Migrations added

| File                                        | Contents                                                    |
| ------------------------------------------- | ----------------------------------------------------------- |
| `20260804000500_properties.sql`             | enums, four tables, indexes, `updated_at` triggers          |
| `20260804000600_properties_rls.sql`         | `role_permissions` rows, REVOKE/GRANT, all RLS policies     |
| `20260804000700_properties_rpc.sql`         | `create_property`, `set_property_archived`, `set_property_cover_photo` |
| `20260804000800_property_storage.sql`       | `can_access_property_object`, the private bucket, object policies |

After applying them, **restart PostgREST** (`docker restart
supabase_rest_homestay-saas`). It caches the schema, and the property screens
embed `property_pricing(*)` / `property_photos(*)` through the composite FK —
until the cache reloads those selects fail with `PGRST200` even though the SQL
is correct.

---

## 8. Deliberate omissions

- **One pricing rule type.** `rule_type` exists so seasonal and event rates are
  additive later; only `'base'` is implemented.
- **No image resizing or thumbnails.** Signed URLs point at the original.
  Add an `imgproxy` render path when list pages actually feel slow.
- **No drag-to-reorder photos.** `sort_order` exists and is respected on read;
  only the cover can be chosen from the UI.
- **No map picker.** Latitude/longitude are optional numeric fields next to the
  free-text map location.
- **No bulk actions**, no CSV import, no property duplication.
