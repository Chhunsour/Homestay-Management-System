# Phase 5 testing

What proves the payment, deposit, balance, refund, duplicate, proof and receipt
work. The Phase 1–4 plans ([PHASE_1_TESTING.md](PHASE_1_TESTING.md),
[PHASE_2_TESTING.md](PHASE_2_TESTING.md), [PHASE_3_TESTING.md](PHASE_3_TESTING.md),
[PHASE_4_TESTING.md](PHASE_4_TESTING.md)) still apply unchanged; section 7
re-runs all four as a regression check.

## 1. Automated checks

```bash
npm run lint          # eslint, flat config, repo-wide
npm run typecheck     # tsc --noEmit in all three workspaces
npm test              # packages/shared unit tests (node --test)
npm run build         # production build of apps/web
npx expo config --type public   # from apps/mobile
```

### What `npm test` adds in Phase 5

`packages/shared/src/payments.test.ts` — 17 tests over the money rules:

| Test                                                            | Asserts                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `round2` matches `numeric(12,2)` on the cases floats get wrong    | the TS and SQL halves agree on 0.1 + 0.2 and friends                                |
| the deposit is half the total, rounded once                       | `depositRequired()` rounds at the end, not per step                                 |
| voided rows stop counting; recorded ones still count              | verification is not an accounting gate; voiding is                                  |
| a refund is its own row and subtracts from the net                | `total_paid` keeps the original, `net_paid` drops                                   |
| the booking status ladder, rung by rung                           | unpaid → partial → deposit_paid → paid → overpaid → refunded                        |
| `summarizeBookingPayments` reports a balance, never a negative one | the client floors at zero; the status carries the overpayment                       |
| a free booking does not divide by zero                            | `paid_percent` is 0, not `NaN`                                                      |
| overpayment and deposit thresholds are inclusive the right way round | exactly half is deposit_paid, exactly the total is paid, a cent more is overpaid |
| a matching transaction reference is a blocking duplicate          | `isBlockingDuplicate()` is true only for `kind = 'reference'`                        |
| same amount inside the window warns; outside it does not          | the ±30-minute `amount` heuristic                                                    |
| the same screenshot twice is caught by its checksum               | `kind = 'file'`, warning only                                                       |
| voided payments are not duplicates of anything                    | a voided reference is free to reuse                                                  |
| staff record payments and nothing else                            | no verify, correct, void, refund or override                                        |
| managers do everything except void                                | the one owner-only action                                                            |
| a voided payment is terminal for everyone                         | even an owner gets no further actions on it                                          |
| RPC failures map onto translation keys                            | every SQLSTATE the RPCs raise reaches `paymentErrorKey()`                             |
| a refusal carries its evidence in DETAIL                          | `duplicatesFromError()` and `overpaymentFromError()` parse it back                    |

`roles.test.ts` grew the Phase 5 rows: it parses the migration and fails if
`role_permissions` and `ROLE_PERMISSIONS` disagree about `payments.verify`,
`payments.correct`, `payments.refund`, `payments.void`, `payments.override` or
`receipts.manage`.

`i18n.test.ts` covers the 132 new payment/receipt/proof keys automatically: `en`
and `km` must have identical key sets, no Khmer value may equal its English
original, and every Khmer value must contain Khmer codepoints.

## 2. SQL tenant isolation suite

```bash
export SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres
npm run db:test        # supabase db reset, then all five SQL suites
npm run db:test:sql    # all five suites, no reset
```

`db:test:sql` now runs `rls_isolation.sql` (Phase 1), `rls_properties.sql`
(Phase 2), `rls_customers.sql` (Phase 3), `rls_bookings.sql` (Phase 4) and
`rls_payments.sql` (Phase 5). Each runs inside a rolled-back transaction and
aborts on the first failed assertion, so they are safe against a populated
database.

Phase 5 alone:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_payments.sql
```

### Expected output

```
            result
------------------------------
 ALL PAYMENT RLS TESTS PASSED
```

Anything else is a failure. Three helpers keep it honest: `assert` on a plain
condition, `assert_rejected` for a statement that must not succeed (it re-raises
its own assertion errors, so a statement that was supposed to be blocked but
succeeded cannot be mistaken for a pass), and `assert_error`, which additionally
asserts **which** error came back — a permission test that passes because of a
typo in a column name is not a permission test.

### The fixture

Two businesses, five users, money on both sides — so "I saw 0 rows" is never a
false pass:

| Business | Members                                          | Money                                        |
| -------- | ------------------------------------------------ | -------------------------------------------- |
| ALPHA    | alice (owner), mark (manager), sam (staff)       | booking `bk1`: 3 weekday nights × 40 = **120**, deposit **60** |
| BETA     | bella (owner), stan (staff)                      | its own booking, one 100 payment, one receipt |

Plus a suspended ALPHA member, to prove that membership status — not merely
membership — is what grants access.

The running arithmetic on `bk1` is tracked in comments at each step, because
most of what the file proves is that the totals move the way the rules say.

### What the 14 sections cover

| # | Section                        | Proves                                                                                       |
| - | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1 | empty booking                  | total 120, deposit 60, balance 120, status `unpaid`, currency KHR inherited from the booking     |
| 2 | staff records 20               | `PM-2026-000001`, `recorded`, `created_by` = sam, business/customer/currency taken from the booking, status `partial` at 16.67%, booking still pending; zero and negative amounts rejected; `refund` type rejected |
| 3 | staff records 40               | net 60 → `deposit_paid`, booking **auto-confirmed**, pending hold cleared, 2 rows of status history |
| 4 | duplicates                     | `payment_duplicates` finds the reference (case- and space-insensitively); re-using it raises `duplicate_payment`; **staff override → `forbidden`** |
| 5 | manager override               | no reason and a 2-character reason both rejected; with a reason the payment saves and the flags are recorded |
| 6 | overpayment                    | 100 more raises `overpayment`; staff cannot override; owner with a reason can → net 170, `overpaid`, balance −50 |
| 7 | void                           | manager and staff refused; owner needs a reason; the row **stays**, stops counting, writes one `void` adjustment, and frees its reference |
| 8 | verify and correct             | staff refused both; manager verifies; correcting 20 → 30 clears the verification, writes an adjustment holding both amounts |
| 9 | refund                         | more than is left rejected; short reason rejected; a refund creates its own `refund` row, moves the original to `refunded`, links the adjustment; refunding twice and refunding a refund both rejected |
| 10 | proofs                        | staff may insert one; a repeated checksum is reported as `kind = 'file'`; a path outside the business prefix is rejected; a proof on another business's payment is rejected; delete is rejected |
| 11 | no client writes              | update/delete/insert on `payments`, insert/update on `payment_adjustments`, select on `payment_counters` and a direct `next_payment_number()` call all rejected |
| 12 | receipts                      | staff refused; owner issues `RC-2026-000001` (BETA's own first receipt is **also** `RC-2026-000001` — per-business sequences); the snapshot freezes names and totals, and renaming the property, customer or business afterwards does not change it; receipt update, delete and booking delete rejected |
| 13 | tenant isolation              | BETA sees exactly its own payment and **zero** ALPHA payments, proofs, adjustments, receipts, view rows or summaries; every ALPHA-targeted RPC returns `forbidden` for BETA's owner and staff; a **suspended** ALPHA member sees nothing and cannot record |
| 14 | anonymous                     | every table, the view, the summary function and all eight RPCs — including `confirm_on_deposit` — rejected                                   |

### Running against bare PostgreSQL

No Docker needed for the SQL suites — `auth_stub.sql` stands in for the parts of
the `auth` schema the migrations use:

```bash
createdb homestay_test
psql homestay_test -v ON_ERROR_STOP=1 -f supabase/tests/auth_stub.sql
for f in supabase/migrations/*.sql; do psql homestay_test -v ON_ERROR_STOP=1 -f "$f"; done
for t in isolation properties customers bookings payments; do
  psql homestay_test -v ON_ERROR_STOP=1 -f "supabase/tests/rls_$t.sql"
done
```

The two storage migrations detect the missing `storage` schema and skip their
bucket and object policies with a notice; everything they define in `public`
still applies. Never load `auth_stub.sql` against a real Supabase database.

## 3. Manual checks — web

### Payments list (`/payments`)

- [ ] The table lists payments newest first with number, guest, property,
      amount, method and status.
- [ ] Search finds a payment by payment number, by transaction reference, by
      guest name, by guest phone and by booking number.
- [ ] Status, method, property and date-range filters narrow the list, and
      combine.
- [ ] "Show more" pages without losing the filters.
- [ ] Every row links to its payment, its booking and its guest.

### Record a payment

- [ ] From a booking, "record payment" pre-fills the amount still owed on the
      deposit.
- [ ] All four methods save. Date/time, reference, payer name and note save.
- [ ] An amount below 50% saves as a partial payment — **no warning, no
      rejection.**
- [ ] Exactly 50% flips a pending booking to confirmed.
- [ ] The full amount marks the booking fully paid.
- [ ] More than the total shows the overpayment warning; an owner or manager can
      confirm it with a reason; staff cannot.
- [ ] A reference already used on a live payment is blocked; an owner or manager
      can override with a reason; **staff see the warning with no override**.

### Payment detail

- [ ] Amounts, method, dates, reference, payer, note and the audit trail all
      show.
- [ ] Verify stamps who and when. Staff have no verify button, and the server
      refuses if one is forged.
- [ ] Correct changes the amount, requires a reason, clears the verification and
      adds an audit row.
- [ ] Void requires a reason, is owner-only, and leaves the row visible and
      struck through.
- [ ] Refund creates its own row; the booking's net paid drops accordingly.
- [ ] Uploading a JPG, PNG, WebP or PDF proof works; the file appears in the
      payment and in the booking's history.
- [ ] The proof opens through a signed URL. Copy it, sign out, and open it in a
      private window: it must expire, and the bucket must never serve it
      publicly.

### Receipts

- [ ] Issuing a receipt produces `RC-<year>-000001` for the first one of the
      year, and increments per business.
- [ ] The receipt shows receipt number, booking number, guest name and phone,
      property, check-in/checkout, booking total, this payment, total paid,
      balance, method, reference, payment date, business name and who issued it.
- [ ] Print produces a clean page — no navigation, no buttons.
- [ ] **Rename the property and the guest, then reopen the receipt: nothing on
      it changes.**

## 4. Manual checks — mobile

- [ ] The booking screen shows the summary, the payment history and the receipt
      list, and refreshes when you come back to it.
- [ ] Recording a payment from the phone takes one screen and lands on the
      payment.
- [ ] A screenshot from the gallery uploads with a progress state and appears in
      the viewer. (PDFs cannot be picked on mobile — see the limitations.)
- [ ] Void, correct and refund appear only for the roles that have them.
- [ ] A receipt shares as text from the share sheet.
- [ ] The home dashboard shows unpaid bookings, pending deposits, balance due
      and paid today, in the business's currency.
- [ ] Airplane mode: every screen shows the network error and a retry that
      works once the connection is back.

## 5. Permissions — the check that matters

Sign in as each role and confirm both halves: the affordance is absent **and**
the server refuses. The RPC is the boundary; the UI is a courtesy.

| Action                       | Owner | Manager | Staff | Server refusal for staff |
| ---------------------------- | :---: | :-----: | :---: | ------------------------ |
| see balances                 |  ✅   |   ✅    |  ✅   | —                        |
| record a payment             |  ✅   |   ✅    |  ✅   | —                        |
| upload a proof               |  ✅   |   ✅    |  ✅   | —                        |
| verify a payment             |  ✅   |   ✅    |  ❌   | `forbidden`              |
| correct a payment            |  ✅   |   ✅    |  ❌   | `forbidden`              |
| refund a payment             |  ✅   |   ✅    |  ❌   | `forbidden`              |
| override a duplicate         |  ✅   |   ✅    |  ❌   | `forbidden`              |
| override an overpayment      |  ✅   |   ✅    |  ❌   | `forbidden`              |
| void a payment               |  ✅   |   ❌    |  ❌   | `forbidden` (manager too) |
| issue a receipt              |  ✅   |   ✅    |  ❌   | `forbidden`              |
| delete anything financial    |  ❌   |   ❌    |  ❌   | no grant exists          |

Section 13 of the SQL suite asserts every one of these across a business
boundary as well: BETA's owner gets `forbidden` on ALPHA's payments, not an
empty result that could be mistaken for one.

## 6. Localization

- [ ] Switch to ខ្មែរ and walk the whole flow: list, record, detail, warnings,
      refund, receipt. No English leaks.
- [ ] A receipt issued in Khmer stays Khmer when the reader's app is in English —
      the language is a property of the document, not of the viewer.
- [ ] Every error, empty state, loading state and confirmation dialog is
      translated. `npm test` fails if a key exists in one language only.

## 7. Phase 1–4 regression

- [ ] `npm run db:test` — all five SQL suites pass.
- [ ] Sign-in, sign-up, business creation and member management still work.
- [ ] Properties, pricing and photos unchanged.
- [ ] Customers, import and export unchanged.
- [ ] Bookings, calendar, conflicts and pending expiry unchanged — including a
      booking that reaches its deposit, which now confirms itself.

## 8. Results at the close of Phase 5

Everything below was run on 2026-08-06.

| Check                              | Result                                              |
| ---------------------------------- | --------------------------------------------------- |
| `npm run lint`                     | clean                                               |
| `npm run typecheck`                | clean, all three workspaces                          |
| `npm test`                         | **83 pass, 0 fail** (17 new in `payments.test.ts`)   |
| `npm run build` (apps/web)         | succeeds; `/payments`, `/payments/[id]`, `/receipts/[id]` in the route list |
| `npx expo config --type public`    | valid                                               |
| `rls_isolation.sql`                | ALL RLS ISOLATION TESTS PASSED                       |
| `rls_properties.sql`               | ALL PROPERTY RLS TESTS PASSED                        |
| `rls_customers.sql`                | ALL CUSTOMER RLS TESTS PASSED                        |
| `rls_bookings.sql`                 | ALL BOOKING RLS TESTS PASSED                         |
| `rls_payments.sql`                 | ALL PAYMENT RLS TESTS PASSED                         |

The SQL suites were run against a scratch `supabase/postgres` database with all
nineteen migrations applied in order from an empty database, because the local
Supabase stack could not be started on this machine — Docker's port-mapping
layer refused to bind **any** host port, including ones nothing was listening
on. That is an environment fault, not a project one; the fix is a Docker
restart, which was not taken unilaterally with 54 unrelated containers running.
Anyone with a working stack should get identical output from `npm run db:test`.

### Three fixes worth recording

1. **`record_payment` read `timezone` from `businesses`**, where it lives in
   `business_settings`. Every payment insert failed with `column "timezone" does
   not exist` — the first thing the SQL suite hit, and something no amount of
   type-checking would have caught.
2. **`confirm_on_deposit` tried to stamp `pending_resolved_at`** while
   confirming. Phase 4's status trigger clears both hold columns on the way out
   of `pending`, so the write was dead code fighting a trigger. Removed; the
   test now asserts the trigger's behaviour instead.
3. **`anon` could execute every function in `public`.** Supabase's stock default
   privileges grant `EXECUTE` to `anon` at creation time, so the per-function
   `revoke … from public` in Phases 2 and 3 never removed it — which is why
   `rls_properties.sql` and `rls_customers.sql` failed on a clean database.
   `20260805000500_anon_function_lockdown.sql` revokes it across the schema and
   changes the default privileges so new functions start with none.

### Not covered by automation

- The storage bucket policies. The SQL suites run on bare Postgres, where the
  `storage` schema does not exist, so `payment_proofs_object_select` and
  `payment_proofs_object_insert` are exercised only by the manual checks in
  section 3. The `public.can_access_payment_object()` helper they call **is**
  covered, through the `payment_proofs` insert policy that uses the same prefix
  rule.
- `supabase/tests/smoke.mjs` still covers Phases 1–4 over HTTP only; no payment
  endpoints were added to it.
- Concurrency. The numbering race is argued from the `on conflict do update …
  returning` row lock and the partial unique index on references, not from a
  test that runs two clients at once.
