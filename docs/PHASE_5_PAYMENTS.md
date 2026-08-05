# Phase 5 — payments, deposits, balances, receipts and payment proofs

Phase 5 puts money on top of the booking Phase 4 created. A **payment** belongs
to a booking, a customer and a business — all three, and all three must agree,
which the composite foreign keys make structural rather than hopeful.

The workflow this phase was built around is the one that actually happens: a
guest sends money over ABA or KHQR, screenshots the confirmation into a
Messenger thread, and an owner or staff member types the amount into the phone
at 9pm. Everything else — the web table, the filters, the printable receipt —
exists to review afterwards what that thirty seconds recorded.

Deliberately absent, not stubbed: OCR of the screenshot (Phase 6),
subscriptions, platform billing, revenue reporting beyond the four dashboard
figures, and any page a guest could open. Guests still never sign in.

---

## 1. Data model

```
businesses ──< bookings ──< payments ──< payment_proofs
           │                       └──< payment_adjustments
           ├──< customers ─────────┘
           ├──< receipts ──────────┘
           ├──< payment_counters
           └──< receipt_counters
```

### `payments`

| Column                                            | Notes                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `id`, `business_id`                               | uuid PK; `unique (id, business_id)` for the composite FKs below         |
| `booking_id`, `customer_id`                       | composite FKs `(id, business_id)`, `on delete restrict`                 |
| `payment_number`                                  | `PM-<year>-<six>`, unique per business, CHECK-enforced shape            |
| `amount`                                          | `numeric(12,2)`, CHECK `> 0` — refunds are stored **positive** too      |
| `currency`, `exchange_rate`                       | copied from the booking, never chosen by the caller                     |
| `method`                                          | `payment_method` — `aba`, `khqr`, `bank_transfer`, `cash`               |
| `payment_type`                                    | `payment_type` — `deposit`, `balance`, `full`, `refund`, `adjustment`   |
| `status`                                          | `payment_status` — `recorded`, `verified`, `voided`, `refunded`         |
| `paid_at`                                         | when the money moved, not when it was typed                             |
| `reference`, `payer_name`, `note`                 | free text, length-checked                                               |
| `duplicate_override`, `overpayment_override`      | set when this row was allowed past a warning                            |
| `override_reason`                                 | CHECK: required as soon as either override is true                      |
| `verified_by`, `verified_at`                      | CHECK: both null or both set                                            |
| `created_by`, `created_at`, `updated_at`          | audit                                                                   |

`payment_type` is a **label for the receipt, not a rule.** A guest who sends 30%
is recorded as having sent 30% and the booking stays partially paid; nothing in
the RPC rejects a valid payment for being the "wrong" size. There is no
`partial` type, because partial is a property of the booking's balance, not of
the row.

The currency and exchange rate are copied from the booking at insert time. A
stay quoted in KHR is paid in KHR, and the rate that applied on the day stays on
the row — later edits to the business's default currency cannot rewrite history.

### `payment_proofs`

The screenshot. The bytes live in a private bucket; this table is metadata only.

| Column                | Notes                                                             |
| --------------------- | ----------------------------------------------------------------- |
| `storage_path`        | globally unique; `businesses/{businessId}/payments/{paymentId}/…`   |
| `file_name`           | what the uploader called it                                        |
| `mime_type`           | CHECK: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`   |
| `size_bytes`          | CHECK: 1 byte – 10 MB                                              |
| `checksum`            | optional SHA-256, `^[0-9a-f]{64}$` — used to **warn**, never block  |
| `uploaded_by`         | audit                                                              |

`payment_id` is a composite FK on `(payment_id, business_id)`, so a proof
physically cannot hang off another business's payment.

### `payment_adjustments`

Why a payment stopped being what it was. Append-only: no UPDATE grant, no DELETE
grant, no policy that would allow either.

| Column                              | Notes                                                        |
| ----------------------------------- | ------------------------------------------------------------ |
| `action`                            | `payment_adjustment_action` — `void`, `correct`, `refund`     |
| `reason`                            | CHECK: at least 3 characters after trimming                   |
| `original_amount`                   | what the payment said before                                  |
| `corrected_amount`                  | null for a void — nothing replaced it, it stopped counting    |
| `refund_payment_id`                 | the `refund` row this adjustment created                      |
| `created_by`, `created_at`          | audit                                                        |

### `receipts`

A frozen document, not a view.

| Column           | Notes                                                                |
| ---------------- | -------------------------------------------------------------------- |
| `receipt_number` | `RC-<year>-<six>`, unique per business                                |
| `language`       | CHECK: `en` or `km` — the language it was issued in, kept forever      |
| `snapshot`       | jsonb; guest name, phone, property, dates and every total at issue    |
| `payment_id`     | optional: a receipt for one payment, or for the booking as a whole    |
| `issued_by`, `issued_at` | audit                                                         |

**Everything a receipt displays comes out of `snapshot`.** Renaming the property
next month, correcting the guest's phone number or editing the business name
does not rewrite a receipt the guest already has in their phone. Both the web
page and the mobile screen render from the snapshot and never re-join.

### `payment_counters` / `receipt_counters`

`(business_id, year, last_number)`. No grants at all, RLS on with no policy: the
only things that touch them are the two SECURITY DEFINER number generators.

---

## 2. Deposit and balance rules

One definition, written twice on purpose:

- `public.booking_payment_summary(booking_id)` — the server's answer, and what
  every RPC decides with.
- `summarizeBookingPayments()` in `packages/shared/src/payments.ts` — the same
  arithmetic for both clients, so a screen can show a balance without a round
  trip.

Neither reads a stored balance column, because there isn't one. **Nothing in
this schema holds a manually edited total**; every figure is derived from the
payment rows every time it is asked for.

| Figure             | Definition                                                |
| ------------------ | --------------------------------------------------------- |
| `booking_total`    | `bookings.final_price` — Phase 4's number, untouched        |
| `deposit_required` | `round(booking_total * 0.5, 2)`                             |
| `total_paid`       | Σ amount where `payment_type <> 'refund'`                   |
| `refund_total`     | Σ amount where `payment_type = 'refund'`                    |
| `net_paid`         | `total_paid − refund_total`                                 |
| `balance`          | `booking_total − net_paid` (negative when overpaid)         |
| `paid_percent`     | `net_paid × 100 / booking_total`, 0 when the total is 0     |

One deliberate difference between the two: the SQL `balance` goes negative when
a booking is overpaid (the audit answer — the summary function is what the RPCs
decide with), while `summarizeBookingPayments()` floors it at zero, because
"you owe -$20" is not a sentence anyone should read out to a guest. The
overpayment is reported by the status and by `net_paid` instead.

**Which rows count:** every payment whose `status <> 'voided'`. A payment that
has been recorded but not yet verified is still money the guest has sent —
holding a booking's confirmation hostage to an office task is how a deposit gets
taken twice. Verification is an audit signal, not an accounting gate. Voiding is
the only thing that makes an amount stop counting, and it always leaves an
adjustment row behind.

### Statuses

Evaluated in this order (`booking_payment_summary`, mirrored by
`bookingPaymentStatus()`):

| Status         | Condition                                     |
| -------------- | --------------------------------------------- |
| `refunded`     | `net_paid <= 0` and something was refunded     |
| `unpaid`       | `net_paid <= 0`                                |
| `overpaid`     | `net_paid > booking_total`                     |
| `paid`         | `net_paid >= booking_total`                    |
| `deposit_paid` | `net_paid >= deposit_required`                 |
| `partial`      | anything else above zero                       |

The order is what makes the thresholds inclusive the right way round: exactly
half is `deposit_paid`, exactly the total is `paid`, a cent more is `overpaid`.

### Automatic confirmation

`confirm_on_deposit(booking_id)` runs inside `record_payment`, in the same
transaction:

1. The booking's status code must be `pending` — anything else returns.
2. `net_paid` must have reached `deposit_required`.
3. The business's system `confirmed` status must still be active. If an owner
   deactivated it, the booking is left alone rather than forced into a status
   they removed.

The status change goes through the ordinary Phase 4 trigger, so it clears the
pending hold columns and writes a `booking_status_history` row like any manual
change. It is `SECURITY DEFINER` and has **no grant to anyone** — it is only
reachable from inside `record_payment`.

---

## 3. Payment and receipt numbers

`PM-2026-000001`, `RC-2026-000001`. One sequence per business per year, both
built the same way as Phase 4's booking numbers:

```sql
insert into public.payment_counters (business_id, year, last_number)
values (p_business_id, v_year, 1)
on conflict (business_id, year)
do update set last_number = public.payment_counters.last_number + 1
returning last_number into v_seq;
```

The `on conflict do update … returning` takes a row lock, so two owners saving
at the same instant serialise and get consecutive numbers rather than the same
one. The year comes from the business's own timezone (`business_settings`), not
the server's, so a payment recorded at 00:30 in Phnom Penh belongs to the year
it is in Phnom Penh.

Sequences are per business: ALPHA's first receipt and BETA's first receipt are
both `RC-2026-000001`, and neither can see the other's.

---

## 4. Duplicate detection

`payment_duplicates(booking_id, reference, amount, paid_at, checksum, exclude_id)`
returns the candidate matches before anything is written. Three kinds:

| Kind        | Match                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| `reference` | same business, same transaction reference, case- and space-insensitive    |
| `amount`    | same booking, same amount, within ±30 minutes of `paid_at` (`PAYMENT_DUPLICATE_MINUTES`) |
| `file`      | same business, same proof checksum                                       |

Only `reference` blocks. `isBlockingDuplicate()` in the shared package encodes
that, so both clients agree on what is a stop sign and what is a note.

The block is a **partial unique index**, not a hopeful check in the application:

```sql
create unique index payments_reference_key
  on public.payments (business_id, lower(btrim(reference)))
  where reference is not null and status <> 'voided' and not duplicate_override;
```

Consequences worth knowing:

- Two clients racing on the same reference: the second one gets a constraint
  violation, not a duplicate row.
- Voiding a payment frees its reference again.
- An overridden row is outside the index, which is what lets an owner record the
  genuine second transfer that reused a reference.

`record_payment` raises `duplicate_payment` (SQLSTATE 23505) with the matching
rows as JSON in `DETAIL`, which `duplicatesFromError()` unpacks for the warning
panel. Overriding requires `payments.override` **and** a reason of at least
three characters (`override_reason_required` otherwise). Staff have neither, and
get `forbidden` — the UI hides the override field for them, and the RPC refuses
it if they send one anyway.

Overpayment behaves the same way: `record_payment` raises `overpayment` (22023,
JSON in `DETAIL`) rather than silently accepting an amount past the booking
total, and only `payments.override` plus a reason lets it through.

---

## 5. Corrections, voids and refunds

No financial row is ever deleted. There is no DELETE grant on `payments`,
`payment_proofs`, `payment_adjustments` or `receipts`, and no policy that would
allow one.

| Action    | Permission          | What happens                                                                                              |
| --------- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| verify    | `payments.verify`   | stamps `verified_by`/`verified_at`; status `recorded` → `verified`                                          |
| correct   | `payments.correct`  | changes the amount (and optionally method, date, reference, payer, note); status returns to `recorded` and the verification is cleared; writes a `correct` adjustment holding both amounts |
| void      | `payments.void`     | status → `voided`; the row stays, stops counting, frees its reference; writes a `void` adjustment            |
| refund    | `payments.refund`   | inserts a **new** `payment_type = 'refund'` row with its own payment number; the original keeps its amount and moves to `refunded`; writes a `refund` adjustment linking the two |

Every one of them requires a reason of at least three characters
(`reason_required`), re-reads the row inside the RPC, re-checks the role against
that row's business, and writes the audit record in the same transaction as the
change it explains.

Rules the RPCs enforce that are easy to get wrong:

- A voided payment is terminal. Verify, correct, refund and further voids all
  raise `payment_voided`.
- A refund cannot exceed what is left un-refunded on that payment
  (`invalid_amount`), so a payment cannot be refunded twice.
- A refund row cannot itself be refunded (`invalid_payment_type`).
- `record_payment` refuses `payment_type = 'refund'` — refunds only come from
  `refund_payment`, which is the only path that writes the audit link.

### Error contract

Same shape as Phases 1–4; `paymentErrorKey()` maps each to a translation key.

| Error                      | SQLSTATE | Meaning                                        |
| -------------------------- | -------- | ---------------------------------------------- |
| `auth_required`            | 28000    | no session                                     |
| `forbidden`                | 42501    | wrong role, or another business's row           |
| `booking_not_found`        | P0002    | booking missing or not visible                  |
| `payment_not_found`        | P0002    | payment missing or not visible                  |
| `invalid_amount`           | 22023    | zero, negative, or more than is refundable      |
| `invalid_payment_type`     | 22023    | refund where a payment belongs, or vice versa   |
| `reason_required`          | 22023    | correction/void/refund with no reason           |
| `override_reason_required` | 22023    | override attempted without a reason             |
| `payment_voided`           | 22023    | the row is terminal                             |
| `duplicate_payment`        | 23505    | blocking duplicate; matches in `DETAIL`         |
| `overpayment`              | 22023    | past the booking total; figures in `DETAIL`     |

---

## 6. Permissions

Added to `role_permissions` (and mirrored in `packages/shared/src/roles.ts`,
which `roles.test.ts` fails on if they drift):

| Permission          | Owner | Manager | Staff |
| ------------------- | :---: | :-----: | :---: |
| `payments.manage`   |  ✅   |   ✅    |  ✅   |
| `payments.verify`   |  ✅   |   ✅    |  —    |
| `payments.correct`  |  ✅   |   ✅    |  —    |
| `payments.refund`   |  ✅   |   ✅    |  —    |
| `payments.override` |  ✅   |   ✅    |  —    |
| `payments.void`     |  ✅   |   —     |  —    |
| `receipts.manage`   |  ✅   |   ✅    |  —    |

`payments.manage` is the read permission as well as the record permission: staff
see what a booking owes, record a payment and upload a proof. That is the whole
list.

Voiding is owner-only on purpose. It is the one action that makes money stop
counting without leaving a compensating row, which puts it in the same drawer as
`properties.archive` and `bookings.restore`. A manager who needs the effect uses
a correction or a refund, both of which are reversible reading.

---

## 7. RLS and privileges

RLS is on for all six new tables. The policies are one line each:

```sql
using (public.has_business_permission(business_id, 'payments.manage'))
```

`has_business_permission` resolves the caller's role from `auth.uid()` for
exactly that row's business, so a `business_id` supplied by a client buys
nothing — it filters rows the caller could already see and cannot conjure any.
A suspended member resolves to no role and sees nothing.

Grants, which is where most of the enforcement actually lives:

| Table                 | anon | authenticated             |
| --------------------- | ---- | ------------------------- |
| `payments`            | —    | `select`                  |
| `payment_adjustments` | —    | `select`                  |
| `receipts`            | —    | `select`                  |
| `payment_proofs`      | —    | `select`, `insert`        |
| `payment_counters`    | —    | —                         |
| `receipt_counters`    | —    | —                         |

No UPDATE and no DELETE anywhere. Every state change goes through an RPC that
re-checks the role and writes an audit row; the missing grant is what guarantees
it, not the UI.

`payment_proofs` INSERT is the one client write, because the bytes go straight
from the device to storage and the metadata row follows. Its `with check`
additionally requires the object key to sit under
`businesses/{business_id}/payments/`, so a row cannot be created for a path the
storage policy would refuse.

`booking_payment_totals` is a `security_invoker = true` view: it runs as the
caller, so the `payments` and `bookings` policies still filter it row by row.
Without that flag it would be a tenant-wide leak wearing a view's clothes.

`20260805000500_anon_function_lockdown.sql` closes a gap that predates this
phase: Supabase's stock default privileges grant `EXECUTE` on every new function
in `public` to `anon`, so the per-function `revoke … from public` in earlier
migrations never removed anon's own grant. The migration revokes execute from
`anon` on every existing function in `public` and changes the default privileges
so new ones start with none. The RPCs all raised `auth_required` anyway; the
pure helpers (`normalize_phone`, `can_access_*_object`) did not.

---

## 8. Payment proof storage

Private bucket `payment-proofs`, 10 MB limit, MIME allow-list
(`image/jpeg`, `image/png`, `image/webp`, `application/pdf`).

Object key layout, enforced by both the bucket policies and the table policy:

```
businesses/{businessId}/payments/{paymentId}/{fileName}
```

`can_access_payment_object(name, permission)` pattern-matches that key, takes
element 2 as the business id, and runs `has_business_permission` on it. Two
policies use it — `select` and `insert` — and there is no `update` or `delete`
policy at all. A payment proof is evidence: a screenshot attached to the wrong
payment is dealt with by correcting or voiding the payment, which leaves an
audit row, not by quietly removing the picture.

**No public URL is ever produced.** Both apps read proofs through short-lived
signed URLs (`signedProofUrls()`), minted server-side per request from a client
that carries the caller's session. The bucket is not public, so a leaked path is
not a leaked file.

The `storage` bucket setup is wrapped in a guard on the `storage` schema
existing, so the SQL suites can run the same migrations against bare Postgres.

---

## 9. Shared package

`packages/shared/src/payments.ts` — used verbatim by both apps:

- `depositRequired()`, `round2()`, `sumPayments()`, `summarizeBookingPayments()`
- `bookingPaymentStatus()`, `countsTowardBalance()`, `reachesDeposit()`,
  `isOverpayment()`
- `findDuplicates()`, `isBlockingDuplicate()`
- `canOverridePayment()`, `canVerifyPayment()`, `canCorrectPayment()`,
  `canRefundPayment()`, `canVoidPayment()`
- `paymentMethodKey()`, `paymentTypeKey()`, `paymentStatusKey()`,
  `bookingPaymentStatusKey()`, `BOOKING_PAYMENT_COLORS`
- `paymentErrorKey()`, `duplicatesFromError()`, `overpaymentFromError()`

Types in `types.ts` (`Payment`, `PaymentWithDetails`, `PaymentProof`,
`PaymentAdjustment`, `Receipt`, `ReceiptSnapshot`, `BookingPaymentSummary`,
`PaymentDuplicate`, `OverpaymentDetail`), validation in `schemas.ts`,
translations in `i18n/en.ts` and `i18n/km.ts` — 132 payment, receipt and proof
keys in each, and the i18n test fails if either file is missing a key the other
has.

---

## 10. Web (`apps/web`)

| Route                  | What it does                                                             |
| ---------------------- | ------------------------------------------------------------------------ |
| `/payments`            | table, search, filters, paging, links to booking and guest               |
| `/payments/[id]`       | detail: amounts, audit trail, proof viewer, verify/correct/void/refund    |
| `/receipts/[id]`       | printable receipt rendered from the snapshot, in the language it was issued |
| `/bookings/[id]`       | gains the payment summary, history and record button (`BookingPayments`)  |
| `/dashboard`           | unpaid bookings, pending deposits, balance due, paid today                |

Search matches payment number, transaction reference, customer name or phone,
and booking number; filters cover status, method, property, and a date range in
the business's timezone. Server actions in `lib/actions/payments.ts` are the
only write path, and each one re-reads the caller's business context server-side
rather than trusting the form.

## 11. Mobile (`apps/mobile`)

| Screen                       | What it does                                                        |
| ---------------------------- | ------------------------------------------------------------------- |
| `booking/[id]`               | payment summary, history, receipts (`BookingPayments`)               |
| `booking/[id]/payment`       | record: amount pre-filled with what is missing from the deposit      |
| `payment/[id]`               | detail, proof upload and viewer, verify/correct/void/refund          |
| `receipt/[id]`               | receipt from the snapshot, with a share action                       |
| `(tabs)/index`               | unpaid bookings, pending deposits, balance due, paid today           |

The record form defaults to the outstanding deposit and to `balance` once
anything has been paid, because that is what an owner types most often. Saving
goes straight to the payment screen, where the screenshot gets attached.

---

## 12. Migrations added

| File                                        | Contents                                                     |
| ------------------------------------------- | ------------------------------------------------------------ |
| `20260805000100_payments.sql`               | enums, four tables, two counters, numbering, summary + view    |
| `20260805000200_payments_rls.sql`           | permission rows, RLS, grants, policies                        |
| `20260805000300_payments_rpc.sql`           | the eight RPCs and their grants                               |
| `20260805000400_payment_storage.sql`        | `payment-proofs` bucket, key helper, object policies          |
| `20260805000500_anon_function_lockdown.sql` | revoke execute from `anon` across `public`                    |

---

## 13. Known limitations

- **Verification is not an accounting gate.** Unverified payments count toward
  the balance and can confirm a booking. This is deliberate (see §2) but it does
  mean a mistyped amount confirms a booking until someone corrects it — which is
  why correcting is one tap and leaves a trail.
- **PDF proofs cannot be uploaded from the phone.** `expo-image-picker` offers
  images only; the web dashboard accepts PDFs. A document proof is a desk job.
- **No PDF generation.** Receipts print from the browser (`window.print()`, with
  a print stylesheet) and share as text from mobile. A real PDF or image export
  needs a renderer neither app currently ships.
- **Checksums are best-effort.** The mobile client computes SHA-256 with
  `expo-crypto`; a file that arrives without one simply skips the `file`
  duplicate check.
- **The amount-window duplicate check is a warning only**, and its 30-minute
  window is a constant rather than a per-business setting.
- **No multi-currency payment.** A booking's currency is the payment's currency;
  there is no conversion at payment time beyond the exchange-rate snapshot
  carried from the booking.
- **No OCR.** Reading the amount and reference off the screenshot is Phase 6;
  Phase 5 stores and displays the image and nothing more.
