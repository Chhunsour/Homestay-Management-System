# Supabase setup

Two paths: **local** (Docker, everything in code) and **hosted** (a Supabase
project, where some steps can only be done in the dashboard). The dashboard-only
steps are collected in their own section at the end — nothing else in this repo
requires clicking.

---

## 1. Local development

### Ports

`supabase/config.toml` deliberately offsets every port so this stack can run
next to other Supabase projects:

| Service     | Port    |
| ----------- | ------- |
| API         | `54331` |
| Database    | `54332` |
| Shadow DB   | `54330` |
| Studio      | `54333` |
| Mailbox     | `54334` |

### Start

```bash
npm run db:start
```

The CLI prints `API URL`, `anon key` and `service_role key`. Copy the API URL
and the **anon** key into `apps/web/.env.local` and `apps/mobile/.env` (see
`.env.example`). The service role key is not used by either app and must not be
placed in any `.env` this repo reads.

### Apply migrations

```bash
npm run db:reset     # drops, recreates, replays every migration in order
npm run db:push      # apply new migrations to a linked remote project
```

Migrations run in filename order and are split by concern:

| File                                     | Contents                                              |
| ---------------------------------------- | ----------------------------------------------------- |
| `20260804000100_core_schema.sql`         | enums, tables, indexes, `set_updated_at`, `handle_new_user` |
| `20260804000200_security_functions.sql`  | `role_permissions` + the SECURITY DEFINER helpers      |
| `20260804000300_rls_policies.sql`        | `alter table … enable row level security`, REVOKE/GRANT, policies |
| `20260804000400_rpc.sql`                 | `create_business`, `set_member_role`, `remove_member`, `soft_delete_business` |
| `20260804000500_properties.sql`          | `properties`, `property_photos`, `property_pricing`, `property_blocks`, block-reason enum, indexes, updated-at triggers |
| `20260804000600_properties_rls.sql`      | the six `properties.*` permissions, REVOKE/GRANT and RLS policies for all four tables |
| `20260804000700_properties_rpc.sql`      | `create_property`, `set_property_archived`, `set_property_cover_photo` |
| `20260804000800_property_storage.sql`    | the private `property-photos` bucket, `can_access_property_object`, storage policies |
| `20260804000900_customers.sql`           | `normalize_phone`, `customers`, `customer_notes`, the phone-normalisation trigger, CHECK constraints, both phone indexes |
| `20260804001000_customers_rls.sql`       | the four `customers.*` permissions, REVOKE/GRANT and RLS policies for both tables |
| `20260804001100_customers_rpc.sql`       | `set_customer_archived`, `import_customers`, `export_customers`        |
| `20260804001200_bookings.sql`            | `booking_status_code` enum, `booking_statuses`, `booking_counters`, `bookings`, `booking_status_history`, the status seed trigger and back-fill, `booking_calculated_price`, `next_booking_number` |
| `20260804001300_bookings_rls.sql`        | the six `bookings.*` permissions, REVOKE/GRANT (including the column-level `update (note, internal_note)` grant) and RLS policies for all four tables |
| `20260804001400_bookings_rpc.sql`        | `booking_conflicts`, `check_booking_availability`, `save_booking`, `set_booking_status`, `resolve_pending_booking` |
| `20260805000100_payments.sql`            | the four payment enums, `payments`, `payment_proofs`, `payment_adjustments`, `receipts`, `payment_counters`, `receipt_counters`, `next_payment_number`, `next_receipt_number`, `booking_payment_totals`, `booking_payment_summary` |
| `20260805000200_payments_rls.sql`        | the six `payments.*`/`receipts.*` permissions, REVOKE/GRANT (no UPDATE or DELETE anywhere) and RLS policies for all four tables |
| `20260805000300_payments_rpc.sql`        | `payment_duplicates`, `confirm_on_deposit`, `record_payment`, `verify_payment`, `void_payment`, `correct_payment`, `refund_payment`, `issue_receipt` |
| `20260805000400_payment_storage.sql`     | the private `payment-proofs` bucket, `can_access_payment_object`, storage policies |
| `20260805000500_anon_function_lockdown.sql` | revokes EXECUTE from `anon` on every function in `public` and changes the schema's default privileges so new ones start with none |

> **After a migration that adds or repoints a foreign key or a function**,
> restart PostgREST — `docker restart supabase_rest_homestay-saas`. It keeps its
> own schema cache, so until it reloads, embedded selects (`profiles(...)`) fail
> with `PGRST200` and new RPCs with `PGRST202`, even though the SQL is correct
> and `psql` sees it. `NOTIFY pgrst, 'reload schema'` did not reliably clear it.

### Auth in local dev

Already configured in `supabase/config.toml`:

- `site_url = "http://localhost:3000"`.
- Redirect allow-list: `http://localhost:3000/auth/callback`,
  `homestay://auth/callback`, `exp://127.0.0.1:8081/--/auth/callback`.
- Email confirmations on. Confirmation and reset emails are **not** sent — open
  the local mailbox at <http://127.0.0.1:54334> to read them. (The config
  section is `[local_smtp]`; older CLI versions called it `[inbucket]` and now
  warn on startup.)
- Phone OTP: sign in with `+85512000000` and the code `123456`. Add more under
  `[auth.sms.test_otp]`. **A provider must also be enabled** — GoTrue disables
  phone login wholesale when none is, and `[auth.sms.test_otp]` is then never
  reached, so `/auth/v1/otp` returns `phone_provider_disabled`. `[auth.sms.twilio]`
  is therefore switched on with obviously-fake placeholder ids; test numbers
  short-circuit before any request leaves the container, so nothing is sent and
  no real credential is needed. Export any value for
  `SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN` before `supabase start`.
- Google and Apple are `enabled = false` locally. To try them, export
  `SUPABASE_AUTH_GOOGLE_CLIENT_ID` / `SUPABASE_AUTH_GOOGLE_SECRET` (and the
  Apple equivalents), flip `enabled = true`, and `supabase stop && supabase start`.

Turning a provider off in the app is separate and independent: drop it from
`NEXT_PUBLIC_AUTH_PROVIDERS` / `EXPO_PUBLIC_AUTH_PROVIDERS` and both the button
and the flow disappear.

---

## 2. Hosted project

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

Then set the environment variables for each app from
**Project Settings → API**:

| Variable                                                   | Value                        |
| ---------------------------------------------------------- | ---------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_URL`     | Project URL                  |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` | anon / public key      |
| `NEXT_PUBLIC_SITE_URL` / `EXPO_PUBLIC_SITE_URL`             | deployed web origin          |
| `NEXT_PUBLIC_AUTH_PROVIDERS` / `EXPO_PUBLIC_AUTH_PROVIDERS` | subset of `password,phone,google,apple` |
| `EXPO_PUBLIC_APP_SCHEME`                                    | must equal the app's `scheme` (`homestay`) |

---

## 3. Dashboard-only steps

These cannot be done from this repository. Each is required only for the
feature next to it.

### 3.1 Redirect URLs — required for OAuth and password reset

**Authentication → URL Configuration**

- Site URL: your deployed web origin, e.g. `https://app.example.com`.
- Redirect URLs (add all that apply):
  - `https://app.example.com/auth/callback`
  - `http://localhost:3000/auth/callback`
  - `homestay://auth/callback` — the mobile deep link; OAuth on device fails
    silently without it
  - `exp://127.0.0.1:8081/--/auth/callback` — Expo Go during development

### 3.2 Google sign-in

1. Google Cloud Console → **APIs & Services → Credentials → OAuth client ID →
   Web application**.
2. Authorised redirect URI:
   `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Supabase → **Authentication → Providers → Google** → enable, paste the
   client ID and secret.
4. Add `google` to `*_AUTH_PROVIDERS`.

The mobile app opens the same web flow in a system browser, so no separate
Android/iOS OAuth client is needed for Phase 1.

### 3.3 Apple sign-in

1. Apple Developer → **Certificates, Identifiers & Profiles**: an App ID with
   *Sign in with Apple*, a Services ID, a Key, and your Team ID.
2. Return URL on the Services ID:
   `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Supabase → **Authentication → Providers → Apple** → enable, set the Services
   ID as client ID and the generated secret.
4. Add `apple` to `*_AUTH_PROVIDERS`.

Note: Apple requires native Sign in with Apple for App Store submission of an
iOS build that offers other social logins. Phase 1 ships the web flow; adding
`expo-apple-authentication` is a Phase 2 task, tracked in ARCHITECTURE.md's
omissions list.

### 3.4 SMS provider — required for phone OTP in production

**Authentication → Providers → Phone** → enable, then configure Twilio,
MessageBird, Vonage or Textlocal with that provider's credentials. Without
this, `signInWithOtp({ phone })` returns a provider error in a hosted project.
Cambodia numbers are `+855…`; the app sends E.164 and does not normalise
locally-formatted input.

### 3.5 SMTP — required for real confirmation and reset emails

**Project Settings → Authentication → SMTP Settings.** The built-in sender is
rate-limited and unsuitable for production. Configure Resend, SendGrid,
Postmark or your own SMTP host, and set a sender address on a domain you own.

Then customise **Authentication → Email Templates** — the default templates are
English-only, so a Khmer-preferring user gets an English email. Supabase does
not localise templates per user; the pragmatic option is bilingual templates.

### 3.6 Auth policy settings (recommended, not required)

**Authentication → Providers → Email**: keep *Confirm email* on.
**Authentication → Policies / Rate limits**: the defaults are fine for Phase 1.
Leave *Enable anonymous sign-ins* off — the RLS model assumes a real `auth.uid()`.

### 3.7 Storage — the `property-photos` bucket

**Nothing to click.** Migration `20260804000800_property_storage.sql` creates the
bucket and its four policies, and re-applying it is idempotent (`on conflict do
update`), so a hosted project gets the same configuration as local. This section
exists so you can verify it, and so you know what to recreate if someone deletes
it from the dashboard.

**Storage → Buckets → `property-photos`** must read:

| Setting             | Value                                       |
| ------------------- | ------------------------------------------- |
| Public bucket       | **off** — this is the important one         |
| File size limit     | 10 MB (`10485760` bytes)                    |
| Allowed MIME types  | `image/jpeg`, `image/png`, `image/webp`     |

Private means `…/object/public/property-photos/…` returns nothing at all. Both
apps read photos through short-lived signed URLs and upload with the user's own
session, never a service key.

Object keys are laid out as:

```
businesses/{businessId}/properties/{propertyId}/{fileName}
```

The four policies on `storage.objects` (`select`, `insert`, `update`, `delete`)
all call `public.can_access_property_object(name, '<permission>')`, which takes
the second path segment as the tenant and runs it through the same
`has_business_permission()` matrix as every table — `properties.read` to
download, `properties.photos.manage` to upload, replace or delete. A key that
does not match the expected shape fails the regex and returns false, so a
traversal attempt like `../../etc/passwd` is refused rather than raising.

Size and MIME are enforced by Storage itself as well as by the client, so a
forged request cannot push a 200 MB executable past a check that only exists in
the app.

If you ever recreate the bucket by hand, re-run the migration afterwards —
creating it from the dashboard gives you an unrestricted bucket with no
policies attached.

### 3.8 Booking statuses — nothing to click

Migration `20260804001200_bookings.sql` seeds Pending, Confirmed, Completed and
Cancelled for every business through an `after insert` trigger on `businesses`,
and back-fills any business that already existed. Do not create statuses from
the dashboard: `is_system` rows are protected by a trigger, and a hand-made row
with `is_system = true` would collide with the partial unique index on
`(business_id, code)`.

Owners customise them in the app at `/bookings/statuses`.

### 3.9 Pending-hold expiry — optional, not required to ship

A booking that enters `pending` holds its dates for 30 minutes
(`PENDING_EXPIRY_MINUTES`). **Expiry never releases the dates** — an expired
hold becomes a review item that an owner or manager resolves with
`resolve_pending_booking(id, 'keep' | 'release')`.

Detection is application-side and evaluated at read time, so no scheduling is
required for the feature to work. Add a job only when you want the review list
to reach people who are not looking at the dashboard:

```sql
create extension if not exists pg_cron;

select cron.schedule('booking-holds', '*/5 * * * *', $$
  select public.notify_expired_holds();   -- to be written in Phase 5
$$);
```

Prefer `pg_cron` over a scheduled Edge Function — no network hop and no service
key to leak. Whatever you build, **it must notify, not cancel**: releasing dates
automatically would undo the rule the feature exists to enforce. Query through
the partial index (`where pending_expires_at < now() and pending_resolved_at is
null`) and make the job idempotent so a retry does not send a second message.
`docs/PHASE_4_BOOKINGS.md` §5 has the full reasoning.

### 3.10 Storage — the `payment-proofs` bucket

**Nothing to click.** Migration `20260805000400_payment_storage.sql` creates it
the same way §3.7 creates the photo bucket, with the same `on conflict do
update`, so it is safe to re-apply.

**Storage → Buckets → `payment-proofs`** must read:

| Setting             | Value                                                    |
| ------------------- | -------------------------------------------------------- |
| Public bucket       | **off**                                                   |
| File size limit     | 10 MB (`10485760` bytes)                                  |
| Allowed MIME types  | `image/jpeg`, `image/png`, `image/webp`, `application/pdf` |

PDF is allowed here and not in the photo bucket because a bank transfer receipt
often arrives as one. Object keys are laid out as:

```
businesses/{businessId}/payments/{paymentId}/{fileName}
```

Two policies, `select` and `insert`, both call
`public.can_access_payment_object(name, '<permission>')` — the payment twin of
`can_access_property_object`, taking the second path segment as the tenant. Both
require `payments.manage`, which every role has — a staff member who can record a
payment can see its evidence. There is deliberately **no update and no delete
policy**: a payment proof is financial evidence, so an
object that has been uploaded stays. A key that does not match the shape fails
the regex and is refused.

The proof row and the object are separate: `payment_proofs.storage_path` must
start with the payment's own business prefix, checked by the insert policy, so a
row cannot point at another tenant's file even if the object policy were somehow
bypassed.

### 3.11 Receipt and payment numbering — nothing to click

`payment_counters` and `receipt_counters` are keyed `(business_id, year)` and
have RLS on with no policy at all, so no client can read either one — a counter
is a per-tenant volume figure. `next_payment_number()` and
`next_receipt_number()` are the only readers, they are revoked from
`authenticated`, and they take the year from the business's own
`business_settings.timezone` rather than the server's clock, so a business in
Phnom Penh rolls over to `RC-2027-000001` at its own midnight.

Concurrency is handled by `insert … on conflict (business_id, year) do update set
last_number = counters.last_number + 1 returning last_number`: the upsert holds a
row lock for the rest of the transaction, so two simultaneous receipts queue
instead of colliding. Nothing needs a sequence, and nothing needs an advisory
lock.

---

## 4. Generating database types (optional)

Types are hand-written in `packages/shared/src/types.ts` because Phase 1 has no
committed project ref. Once you have one:

```bash
supabase gen types typescript --linked > packages/shared/src/database.types.ts
```

Then type the clients with `createClient<Database>(…)` and delete the two casts
in `apps/web/src/lib/business.ts`. That is the only place they exist.
