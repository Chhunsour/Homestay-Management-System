# Phase 4 testing

What proves the booking, availability, pricing, conflict-control and
pending-expiry work. The Phase 1–3 plans ([PHASE_1_TESTING.md](PHASE_1_TESTING.md),
[PHASE_2_TESTING.md](PHASE_2_TESTING.md), [PHASE_3_TESTING.md](PHASE_3_TESTING.md))
still apply unchanged — nothing here replaces them, and section 7 below re-runs
all three as a regression check.

## 1. Automated checks

```bash
npm run lint          # eslint, flat config, repo-wide
npm run typecheck     # tsc --noEmit in all three workspaces
npm test              # packages/shared unit tests (node --test)
npm run build         # production build of apps/web
npm run format:check  # prettier
```

`npm run lint` is now **completely** clean. Phase 4 added a flat-config override
turning `no-console` off for `scripts/**/*.mjs` and `supabase/tests/*.mjs` —
printing their results is what those CLI scripts are for, and the long-standing
two-warning baseline was hiding real errors in a third script (see below).

### What `npm test` adds in Phase 4

`packages/shared/src/bookings.test.ts` — pricing, status semantics, the
calendar grids and the error contract:

| Test                                                        | Asserts                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| weekday-only, weekend-only and mixed stays price correctly  | Mon–Thu bill at the weekday rate, Fri–Sun at the weekend rate, and a stay across both sums the two |
| a same-day stay costs one day                               | check-in and check-out on one date is not zero nights                                            |
| a week-long stay counts 4 weekday and 3 weekend nights      | the split is by day of week, not by a ratio                                                      |
| fractional rates round once, at the end                     | summing 32.55 seven times leaves no float dust                                                   |
| days are counted in the business time zone                  | a 23:00 Phnom Penh check-in is that day, not the UTC tomorrow                                    |
| a stay crossing midnight UTC keeps its local dates          | the boundary case the whole `zonedTimeToUtc` pair exists for                                     |
| a manual override replaces the total, not the calculation   | `calculated_price` survives; `finalPrice` returns the override                                   |
| `blocksDatesStatus` follows the code, never the name        | a renamed "Pending" still holds the dates; `cancelled` still releases them                       |
| `statusLabel` translates a system status and defers to a renamed one | an owner's wording wins over the built-in translation                                   |
| `isPendingExpired` needs pending **and** lapsed **and** unresolved | a resolved hold leaves the review list; a confirmed booking never enters it              |
| `monthGrid` / `weekGrid` / `addMonths` produce whole weeks   | 42 cells starting on the right weekday, and month arithmetic across a year boundary             |
| `coversDate` is half-open                                    | a checkout day is free for the next guest; a same-day stay still covers its one date            |
| `bookingSearchFilter` escapes PostgREST syntax               | commas, parentheses and quotes cannot break out of the `or=(…)` filter                          |
| `bookingErrorKey` maps every SQLSTATE the RPCs raise         | `28000`, `42501`, `P0002`, `22023`, `23P01` each reach a translation key                        |
| `conflictsFromError` reads the conflicts out of DETAIL       | the UI can name what is in the way instead of saying "unavailable"                              |
| `isOverridable` refuses an archived or inactive property     | the override affordance is not offered where the server would refuse it anyway                   |

`packages/shared/src/availability.test.ts` — overlap semantics against blocks
**and** bookings:

| Test                                                     | Asserts                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| adjacent ranges never conflict                           | `[a,b)` and `[b,c)` are neighbours — the busy-season default case                 |
| every real overlap is caught                             | contained, containing, straddling the start, straddling the end                    |
| a cancelled booking releases its dates                   | the release path, asserted rather than assumed                                     |
| a cancelled block does not block                         | Phase 2's semantics, unchanged                                                     |
| an inactive or archived property reports its own kind    | `property_inactive` / `property_archived`, not a generic conflict                   |
| `excludeBookingId` lets a booking be edited              | a stay does not conflict with itself when its dates are changed                     |
| conflicts from another business are never considered     | the tenant boundary holds in the pure function too                                  |

`roles.test.ts` grew six rows: it parses the migration and fails if
`role_permissions` and `ROLE_PERMISSIONS` disagree about
`bookings.statuses.manage`, `bookings.conflict.override`,
`bookings.price.override`, `bookings.cancel`, `bookings.restore` or
`bookings.pending.resolve`.

`i18n.test.ts` covers the new keys automatically: `en` and `km` must have
identical key sets, no Khmer value may equal its English original, and every
Khmer value must contain Khmer codepoints.

## 2. SQL tenant isolation suite

```bash
export SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres
npm run db:test        # supabase db reset, then all four SQL suites
npm run db:test:sql    # all four suites, no reset
```

`db:test:sql` now runs `rls_isolation.sql` (Phase 1), `rls_properties.sql`
(Phase 2), `rls_customers.sql` (Phase 3) and `rls_bookings.sql` (Phase 4). All
four run inside a rolled-back transaction and abort on the first failed
assertion, so they are safe against a populated database.

To run only the Phase 4 suite:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_bookings.sql
```

Against bare PostgreSQL (CI, no Docker), load `auth_stub.sql` and all fourteen
migrations first — the Phase 1 doc has the full command; add migrations `…1200`,
`…1300` and `…1400` to its list.

### Expected output

```
            result
------------------------------
 ALL BOOKING RLS TESTS PASSED
```

Anything else is a failure. Two helpers keep it honest: `assert_rejected`
re-raises its own assertion errors, so a statement that was supposed to be
blocked but succeeded cannot be mistaken for a pass; and
`assert_rejected_with` additionally asserts the **SQLSTATE**, because a
permission test that passes because of a typo in a column name is not a
permission test.

### The fixture: two businesses, five users, and bookings on both sides

| Business | Members                                    |
| -------- | ------------------------------------------ |
| ALPHA    | alice (owner), mark (manager), sam (staff) |
| BETA     | bella (owner), stan (staff)                |

Both businesses hold bookings, statuses and blocks, so **"I saw 0 rows" is never
a false pass** — every cross-tenant read is asserted against data that
demonstrably exists on the other side. Each property carries a base rate card of
40 weekday / 60 weekend so the price assertions are exact numbers, not ranges.

| #  | Section                     | Asserts                                                                                                                                                                                            |
| -- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Status seeding              | creating a business yields **exactly** the four system statuses with the four internal codes; each business gets its own copy, so BETA can never share ALPHA's list                                    |
| 2  | Staff may take a booking    | staff hold `bookings.manage`; the **server** sets the price (Mon 7 – Thu 10 Sep = three weekday nights at 40 = 120) and the number (`BK-2026-000001`); pending stamps `pending_expires_at` 30 minutes out; the status history row is written although nobody holds INSERT on that table |
| 3  | Availability                | checking in at 12:00 on the day the last guest leaves is **accepted**; the weekend rate starts on Friday; an overlap is refused for **everyone** by default; **staff cannot buy past it** with an override flag, nor past the price with `p_final_price`; a Phase 2 manual block blocks a booking exactly as an existing stay does |
| 4  | Manager override            | a reason is **not optional even for someone allowed to override**; with one, the booking is written and `conflict_override_by` / `_at` record who approved it and when                                 |
| 5  | Dangerous columns           | a plain `UPDATE` of dates, property, customer, status or price is refused by the column-level grant; only `note` and `internal_note` are writable; a direct `INSERT` into `bookings` fails — there is no policy for it |
| 6  | Status customisation        | the owner may add, rename, recolour, reorder and disable; **manager and staff cannot**; a system status cannot be deleted, recoded or demoted from `is_system`; a duplicate name in one business is refused; a client cannot mint a row with `is_system = true` |
| 7  | Cancel, restore, pending    | staff cannot cancel; manager can; **only the owner can restore**; cancelling frees the dates for a new booking; `resolve_pending_booking('keep')` stamps the resolution without releasing the dates, `('release')` cancels; staff cannot resolve                |
| 8  | Tenant isolation            | asserted from **both** sides — BETA reads no ALPHA booking, status or history and ALPHA's owner reads no BETA row; a forged `p_business_id` is refused; ALPHA cannot book BETA's property, nor attach BETA's customer or BETA's status to its own booking; knowing another tenant's uuid buys nothing; booking numbers restart at `000001` per business |
| 9  | Server-side validation      | a backwards or zero-length range is refused; a negative price is refused; an override reason under 3 characters is refused; an archived or inactive property raises `property_unavailable` and is **not** overridable; an unknown action to `resolve_pending_booking` is refused — none of it depends on the client |
| 10 | Anonymous callers           | `anon` reads none of the three readable tables and can call none of `save_booking`, `set_booking_status`, `resolve_pending_booking`, `check_booking_availability`, `booking_conflicts`, `booking_calculated_price` or `next_booking_number` — privileges are revoked outright, so it fails before RLS is consulted |

## 3. HTTP smoke test

```bash
export SUPABASE_URL=http://127.0.0.1:54331
export SUPABASE_ANON_KEY=...          # both from `npx supabase status`
export SUPABASE_SERVICE_ROLE_KEY=...
npm run db:smoke
```

Phase 4 takes `smoke.mjs` from 32 checks to **43**. These are the ones SQL
cannot see — real HTTP, real JWTs, PostgREST's schema cache, and genuine
concurrency:

| Check                                                            | Why it needs HTTP                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `save_booking` works over PostgREST                               | the RPC signature, argument names and grants as the apps actually call them       |
| the first booking of the year is numbered `BK-2026-000001`        | the counter, end to end                                                            |
| the server priced the stay itself                                 | `calculated_price` comes back 135 for three weekday nights at 45 — the caller sent no price |
| bookings query can embed status, property and customer            | those embeds hang off **composite** FKs, which PostgREST must have in its schema cache; invisible to SQL, a 400 in the browser |
| a back-to-back booking is accepted                                | adjacency over the wire                                                            |
| **two simultaneous bookings of the same dates: exactly one wins** | two requests fired with `Promise.all`, in separate transactions — the advisory lock is what makes this deterministic; without it both scans see free dates and both insert |
| the losing request was refused with `booking_conflict`            | the loser gets the documented error, not a 500                                     |
| a forged business id cannot create a booking in another tenant    | BETA's owner posting ALPHA's `p_business_id` with a valid token                     |
| another tenant reads no bookings at all                           | against a database that demonstrably has some                                      |
| bookings cannot be inserted directly, only through the RPC        | a fully-formed direct `INSERT`, including a hand-written booking number, is refused |

Last line printed is `ALL SUPABASE SMOKE TESTS PASSED`; the process exits
non-zero otherwise.

## 4. Manual checks — web

Sign in as an owner with at least two properties, two customers and a rate card.

### Bookings list

- `/bookings` shows a list, not the old placeholder.
- Search by **booking number**, by **customer name** and by **customer phone** —
  all three find the same booking.
- Filter by property, by status and by date range; the filters survive a page
  reload (they are in the URL) and combine.
- The `upcoming` / `today` / `expired` / `all` filters each return what they
  claim.
- Paging works past 25 rows.

### Create

- `/bookings/new` — pick a property and the check-in / check-out times prefill
  from the property's defaults.
- The price preview updates as the dates change, and matches the total on the
  saved booking.
- Pick a Monday-to-Thursday stay, then a Friday-to-Sunday one: the totals differ
  by the weekday/weekend split.
- Leave a required field empty: the field error is in the current language.
- Create for dates that are already taken: the conflict panel names the booking
  or block in the way. As an owner, supply a reason and save. Try to save with a
  1-character reason — refused.
- Create for an archived property: refused, and **no override is offered**.

### Edit

- Change the dates: the price is re-quoted and availability re-checked.
- Do the same on a booking whose price was manually overridden: a warning appears
  **before** the override is replaced.
- Change the property, then the customer — both re-check availability.
- Shift a booking so it lands adjacent to another: accepted, no warning.

### Detail

- Booking number, property, guest, both times, source, both notes, calculated
  and final price, and the override badge when there is one.
- Change status from the detail panel; complete, cancel and restore all appear
  according to role.
- A booking written over a conflict shows who approved it and when.
- **Duplicate as draft** opens a new booking prefilled from this one, with its
  own number assigned only on save.

### Calendar

- `/calendar` renders a month grid; the `view=week` toggle renders a week.
- Entries show property, guest, status colour, start and end, plus a conflict
  indicator where one was overridden.
- The property filter narrows the grid; previous/next/today move it; the URL
  carries `view`, `date` and `propertyId`.
- A cancelled booking does not appear.
- A checkout day is free for the next guest — an adjacent pair renders as two
  separate stays, not an overlap.

### Statuses

- `/bookings/statuses` — rename "Pending", give it a new colour, move it down the
  order. The list, calendar and detail panel all follow.
- **Nothing else changes**: the renamed status still holds dates, still expires
  after 30 minutes, still counts as pending on the dashboard.
- Try to delete a system status: refused.
- Disable a custom status: it disappears from the picker, stays on the bookings
  that already use it.

### Dashboard

- Today's bookings, upcoming check-ins, upcoming checkouts, available
  properties, pending, and the expired-pending review — all present.
- **No revenue or payment totals anywhere.**

### Both languages

Switch to Khmer and repeat the list, calendar, form and detail panel. No English
string may remain, Khmer script must render (not boxes), month headings and
weekday initials must be Khmer, and KHR amounts must format correctly.

## 5. Manual checks — mobile

Run `npm run dev:mobile` and open on a device or simulator.

- Tabs are Home, Properties, Calendar, Bookings, Customers, Settings — unchanged.
- **Home**: today, check-ins, checkouts, pending, available properties, and the
  expired-hold banner when one exists. No money.
- **Bookings**: search debounces, filter chips work, "show more" pages.
- **Calendar**: the month grid shows a per-day count; tapping a day lists that
  day's stays; tapping a stay opens its detail.
- **Quick booking**: customer, property, check-in and check-out are required;
  price, source and note optional. Enter a guest who is not on file and create
  them **without leaving the screen**, then save — one booking, one new customer.
- Enter a malformed date or time: rejected with a translated message, no crash.
- Book taken dates as an owner: the conflict panel lists what is in the way and
  offers the reason field. Repeat as staff: the same panel appears, but the
  reason field is replaced by "you cannot override this".
- Detail: change status, complete, cancel, restore, review an expired hold,
  duplicate as draft.
- Switch to Khmer in Settings and repeat all of the above; check the Khmer font
  renders on both iOS and Android.

## 6. Permissions — the check that matters

Do this with three real accounts in one business. Hidden UI is not the test; the
point is that the **API** refuses.

| Actor   | Expect                                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner   | everything, including status management and restore                                                                                                       |
| Manager | create, edit, statuses **no**, conflict override **with a reason**, price override **with a reason**, cancel yes, restore **no**                           |
| Staff   | view, create, edit, link customers, notes. **No** conflict override, **no** price override, **no** status customisation, **no** cancel, **no** restore, **no** pending resolution |

Then bypass the UI. As staff, override a conflict directly:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/save_booking" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $STAFF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"p_business_id":"<id>","p_property_id":"<taken property>",
       "p_customer_id":"<id>","p_check_in":"2026-09-08T14:00:00+07:00",
       "p_check_out":"2026-09-09T12:00:00+07:00",
       "p_conflict_override":true,"p_conflict_reason":"the guest insisted"}'
```

It must return `42501`. Repeat with `p_final_price` set to something other than
the rate card (also `42501`), and with `resolve_pending_booking`.

Then try the tenancy bypass, as an owner of business A against a property id
belonging to business B:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/save_booking" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"p_business_id":"<B id>","p_property_id":"<B property>", ... }'
```

It must fail. Knowing another tenant's uuid must buy nothing.

Finally, prove the RPC cannot be skipped:

```bash
curl -s -X PATCH "$SUPABASE_URL/rest/v1/bookings?id=eq.<id>" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $OWNER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"check_in_at":"2026-01-01T14:00:00+07:00","final_price":1}'
```

It must fail on the column grant. Sections 3, 4, 5, 7, 8 and 9 of the SQL suite
assert the same things, but doing it once by hand confirms the token, the policy
and the RPC line up in the deployed environment.

### Pending expiry

Take a booking, leave it pending, and either wait 30 minutes or move the row's
`pending_expires_at` into the past with the service key. Then:

- it appears in the expired list and banner on **both** apps;
- **its dates are still held** — try to book over them and the conflict is
  raised;
- `keep` removes it from the review list without releasing anything;
- `release` cancels it, and only then do the dates become bookable.

## 7. Phase 1–3 regression

Phase 4 added six permissions, four tables and four RPCs; it did not change
authentication, onboarding, properties, pricing rules, photos, blocks,
customers, notes, import or export. Re-run before closing the phase:

- `npm run db:test` — the Phase 1, 2 and 3 suites run first and must still pass.
- `npm run db:smoke` — auth, PostgREST embeds and Storage are unchanged; the 32
  earlier assertions still run ahead of the 11 new ones.
- Manually: sign in, switch language on both apps, open a property, upload a
  photo, create and cancel a block, create a customer, add a note, import and
  export a CSV.

## 8. Results at the close of Phase 4

Run on 2026-08-05 against the local Supabase stack (CLI 2.109.1, Node 24):

| Command                                                     | Result                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run lint`                                              | clean — 0 errors, 0 warnings                                                      |
| `npm run typecheck`                                         | clean in all three workspaces                                                     |
| `npm test`                                                  | 66 passed, 0 failed                                                               |
| `npm run format:check`                                      | clean                                                                             |
| `npm run build`                                             | succeeded; `/bookings`, `/bookings/new`, `/bookings/[id]`, `/bookings/[id]/edit`, `/bookings/statuses` and `/calendar` all present |
| `npm exec --workspace @homestay/mobile -- expo config --type public` | valid (SDK 57)                                                           |
| `supabase db reset`                                         | all fourteen migrations applied                                                   |
| `rls_isolation.sql`                                         | ALL RLS ISOLATION TESTS PASSED                                                    |
| `rls_properties.sql`                                        | ALL PROPERTY RLS TESTS PASSED                                                     |
| `rls_customers.sql`                                         | ALL CUSTOMER RLS TESTS PASSED                                                     |
| `rls_bookings.sql`                                          | ALL BOOKING RLS TESTS PASSED                                                      |
| `npm run db:smoke`                                          | 43 checks, ALL SUPABASE SMOKE TESTS PASSED                                        |

| `node scripts/seed-demo.mjs`                                | seeds the demo tenant; both demo bookings created (`BK-2026-000001`, `BK-2026-000002`) |

Manual web, mobile, permission and localization checks in sections 4–6 are for a
human to run against a stack with real data; the automated rows above are what
CI reproduces.

### One fix worth recording

`scripts/seed-demo.mjs` called `save_booking` with `p_source: 'direct'` (not one
of the six allowed sources) and `p_notes` (the parameter is `p_note`), and never
checked the response — so the demo tenant silently ended up with **zero**
bookings while the script printed success. Both arguments are corrected and the
script now prints the returned booking number, or the refusal. This is why the
`no-console` override matters: the lint noise from that script was covering
three real `no-unused-vars` errors, including the discarded RPC results that
would have shown the failure.
