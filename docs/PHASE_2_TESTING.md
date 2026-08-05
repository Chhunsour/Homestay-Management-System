# Phase 2 testing

What proves the property, pricing, photo and availability work. Phase 1's plan
([PHASE_1_TESTING.md](PHASE_1_TESTING.md)) still applies unchanged — nothing
here replaces it, and section 6 below re-runs it as a regression check.

## 1. Automated checks

```bash
npm run lint          # eslint, flat config, repo-wide
npm run typecheck     # tsc --noEmit in all three workspaces
npm test              # packages/shared unit tests (node --test)
npm run build         # production build of apps/web
npm run format:check  # prettier
```

`npm run lint` is clean apart from two long-standing `no-console` warnings in
`supabase/tests/smoke.mjs`, which is a CLI script and prints its results.

### What `npm test` adds in Phase 2

`packages/shared/src/availability.test.ts`:

| Test                                | Asserts                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| overlapping ranges                  | two ranges that share any instant conflict, including full containment  |
| adjacent ranges                     | `[a, b)` and `[b, c)` do **not** conflict — ranges are half-open         |
| invalid ranges                      | `end <= start` returns an `invalid_range` conflict, not a silent pass    |
| inactive / archived property        | produce `property_inactive` / `property_archived` with no blocks at all  |
| cancelled blocks                    | ignored entirely                                                        |
| tenant isolation                    | blocks belonging to another business or property are ignored            |
| timezone handling                   | `zonedTimeToUtc` resolves wall-clock time in `Asia/Phnom_Penh` correctly |
| weekend definition                  | Friday, Saturday and Sunday are weekend, evaluated locally not in UTC   |
| `rateForNight`                      | picks weekend vs weekday price from the night's local date              |

`roles.test.ts` parses `20260804000600_properties_rls.sql` as well, so the six
new permissions must exist identically in SQL and in TypeScript or the suite
fails.

The i18n tests cover the new `property.*`, `pricing.*`, `photo.*` and `block.*`
keys automatically: one fails if a Khmer value is still the English string,
another if a Khmer value contains no Khmer codepoints.

## 2. SQL tenant isolation suite

```bash
export SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres
npm run db:test        # supabase db reset, then both SQL suites
npm run db:test:sql    # both suites, no reset
```

`db:test:sql` runs `rls_isolation.sql` (Phase 1) followed by
`rls_properties.sql` (Phase 2). Both run inside a rolled-back transaction and
abort on the first failed assertion, so they are safe against a populated
database.

To run only the Phase 2 suite:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_properties.sql
```

Against bare PostgreSQL (CI, no Docker), load `auth_stub.sql` and all eight
migrations first — the Phase 1 doc has the full command; add migrations `…0500`
through `…0800` to its list. The storage migration self-skips when the
`storage` schema is absent.

### Expected output

```
            result
-------------------------------
 ALL PROPERTY RLS TESTS PASSED
```

Anything else is a failure. `assert_rejected` re-raises its own assertion
errors, so a statement that was supposed to be blocked but succeeded cannot be
mistaken for a pass.

### The fixture: two businesses, five users, four properties

| Business | Members                                     | Properties                                        |
| -------- | ------------------------------------------- | ------------------------------------------------- |
| ALPHA    | alice (owner), mark (manager), sam (staff)  | Riverside Villa, Garden House, Manager Cottage    |
| BETA     | bella (owner), stan (staff)                 | Beach House                                       |

BETA owns a property of its own on purpose: "returned 0 rows" can then never be
a false pass caused by an empty table.

| # | Section                | Asserts                                                                                                             |
| - | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1 | Creation via RPC       | `create_property` also creates the base pricing row and stamps `created_by`; currency falls back to the business default; a duplicate live name is rejected |
| 2 | Cross-tenant reads     | asserted from **both** sides — ALPHA sees no BETA property, photo, price or block, and BETA staff sees no ALPHA row, including by explicit id |
| 3 | Cross-tenant writes    | a forged `business_id` cannot create, price, photograph, block, archive or re-cover another tenant's property; a mismatched `business_id` on a child row fails the composite FK; updates and deletes are asserted on effect, since RLS filters rather than raises |
| 4 | Storage authorisation  | `can_access_property_object` grants inside the caller's own prefix, refuses another tenant's prefix, refuses malformed keys; staff may read but not upload; a photo row cannot point at another tenant's path; `created_by` cannot be forged; a non-image mime type is rejected |
| 5 | Role matrix            | staff read everything and change nothing (no create, archive, cover, block, price, rename, deactivate, photo delete); manager can create, deactivate, price and block, but cannot archive — not by RPC and not through a plain `UPDATE` on `archived_at`; inverted and zero-length blocks are rejected; blocks and properties cannot be deleted |
| 6 | Archiving              | an archived property disappears from reads, is forced inactive, and frees its name for reuse                          |
| 7 | Anonymous callers      | `anon` reads no property table and cannot call `create_property` or the storage helper — privileges are revoked outright, so it fails before RLS is consulted |

## 3. HTTP smoke test against a real stack

The SQL suite sets JWT claims directly and never touches GoTrue, PostgREST or
Storage. This one does — including the parts of Phase 2 that only exist above
SQL:

```bash
export SUPABASE_ANON_KEY=...          # both from `npx supabase status`
export SUPABASE_SERVICE_ROLE_KEY=...
npm run db:smoke
```

Phase 2 adds sixteen checks to it:

| Group           | Asserts                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Properties      | `create_property` works over PostgREST; `properties?select=*,property_pricing(*),property_photos(*)` resolves the **composite** FK; naming another tenant's property id returns nothing; a forged `business_id` cannot create a property |
| Storage         | the owner uploads a real PNG into their own prefix; another tenant cannot upload to it or download from it; the bucket serves nothing on the public path; a signed URL is minted and fetches the bytes with no session; the owner deletes their own object |
| Photo metadata  | a row cannot point at another tenant's `storage_path`; a row inside its own prefix is accepted                                              |
| Archive         | `set_property_archived` succeeds for the owner, the property stops being readable, and a hard `DELETE` over the API is refused              |

Two of these exist specifically because SQL cannot see them:

- **the embed check** — `property_pricing` and `property_photos` hang off a
  composite FK. If PostgREST's schema cache has not reloaded, both property
  screens 400 while `psql` reports everything is fine.
- **the numeric check** — the embed assertion compares `weekday_price` to the
  JSON number `45`, not the string `"45.00"`. PostgREST returning strings would
  otherwise degrade money formatting silently.

Last line printed is `ALL SUPABASE SMOKE TESTS PASSED`; the process exits
non-zero otherwise.

## 4. Manual checks — web

Sign in as an owner with at least two properties.

### Property list

- `/properties` shows a card per property with its cover photo, active/inactive
  pill and weekday price.
- Typing in the search box and submitting filters by name **and** address, and
  the term survives in the URL — reload and back both work.
- The active/inactive filter changes the result set and the empty state text
  switches from "no properties yet" to the filtered variant.
- A property with no photo shows the placeholder, not a broken image.

### Create and edit

- `/properties/new` requires a name and both prices; submitting with a 1-char
  name shows a translated field error, not a stack trace.
- Latitude `95` is rejected; latitude `11.55` is accepted.
- Creating a second property with an existing name shows the duplicate-name
  error.
- Edit changes persist and the detail page reflects them immediately.

### Pricing, photos, blocks

- Changing weekday/weekend price and currency saves and re-renders formatted in
  the current locale.
- Uploading a JPG, PNG and WebP each succeed; a PDF is refused with a translated
  message; a file over 10 MB is refused before upload starts.
- "Set as cover" moves the cover badge and updates the list page.
- Deleting a photo asks for confirmation, removes the thumbnail, and — if it was
  the cover — the next photo becomes the cover.
- Creating a block with the end before the start shows a validation error.
- A created block lists in the business timezone (`Asia/Phnom_Penh` by default),
  and cancelling it flips the badge without removing the row.

### Status

- Deactivate/activate toggles the pill.
- Archive asks for confirmation and the property disappears from the list.
  Its name becomes available again.

## 5. Manual checks — mobile

```bash
npx expo config --type public   # must print without error
npm run dev:mobile
```

- The Properties tab appears between Home and Calendar and shows the same list.
- Pull the search field and filter chips; results match the web app.
- Save an edit on the detail screen, go back, and the list reflects it (the list
  reloads on focus).
- The photo picker asks for permission; denying it shows a translated banner
  rather than failing silently.
- Uploading shows the "uploading" label and the photo appears when it finishes.
- Deleting a photo and cancelling a block both go through a native confirm.
- Block date/time fields open a numeric keypad and reject a malformed date.
- Turning airplane mode on and saving shows the network-error banner with a
  retry, not a crash.

## 6. Permissions — the check that matters

Do this with three real accounts in one business. Hidden UI is not the test;
the point is that the **API** refuses.

| Actor   | Expect                                                                             |
| ------- | ---------------------------------------------------------------------------------- |
| Owner   | everything, including Archive                                                      |
| Manager | create, edit, activate, price, photos, blocks — **no** Archive button, and the RPC returns 403 if called directly |
| Staff   | read-only: no New Property button, no edit form, no pricing form, no upload control, no block form; the read-only notice is shown |

Then bypass the UI for staff:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/create_property" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $STAFF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"p_business_id":"<id>","p_name":"Nope","p_weekday_price":1,"p_weekend_price":1}'
```

It must return a `42501` error. Section 5 of the SQL suite asserts the same
thing for every action, but doing it once by hand confirms the token, the
policy and the RPC line up in the deployed environment.

## 7. Phase 1 regression

Phase 2 touched the permission matrix and added tables; it did not change
authentication or onboarding. Re-run before closing the phase:

- `npm run db:test` — the Phase 1 suite runs first and must still pass.
- `npm run db:smoke` — auth, signup trigger and phone OTP checks are unchanged.
- Manually: sign up, confirm by email, sign in, sign out, password reset,
  onboarding for a brand-new user, and language switching between English and
  Khmer on both apps.

## 8. Results at the close of Phase 2

Run on 2026-08-05 against the local Supabase stack (CLI 2.109.1, Node 24):

| Command                            | Result                                              |
| ---------------------------------- | --------------------------------------------------- |
| `npm run lint`                     | 0 errors, 2 pre-existing `no-console` warnings       |
| `npm run typecheck`                | clean in all three workspaces                        |
| `npm test`                         | 19 passed, 0 failed                                  |
| `npm run format:check`             | clean                                                |
| `npm run build`                    | succeeded; all four `/properties*` routes present    |
| `npx expo config --type public`    | valid (SDK 57, `expo-image-picker` plugin present)   |
| `supabase db reset`                | all eight migrations applied                         |
| `rls_isolation.sql`                | ALL RLS ISOLATION TESTS PASSED                       |
| `rls_properties.sql`               | ALL PROPERTY RLS TESTS PASSED                        |
| `npm run db:smoke`                 | 32 checks, ALL SUPABASE SMOKE TESTS PASSED           |
