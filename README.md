# Homestay Manager — Phases 1–5

Internal property-management SaaS for homestay, villa and resort operators.
Owners, managers and staff use it; guests never do.

Phase 1 delivered the foundation: **authentication, business onboarding, roles
and multi-tenant security**. Phase 2 added **properties, weekday/weekend
pricing, private photo storage and manual availability blocks** — a booking will
reserve a whole property, there is no room-level inventory. Phase 3 adds
**customers**: phone-first records with Cambodian number normalization,
duplicate detection, internal staff notes, archive/restore, CSV import and
export. Customers never sign in and internal notes are never exposed publicly.
Phase 4 adds **bookings**: an availability calendar, weekday/weekend pricing
with authorized manual override, customizable statuses, transaction-safe
conflict detection with an audited override, and 30-minute pending holds that
lapse into a review item rather than silently releasing the dates. Phase 5 adds
**money**: payments in ABA, KHQR, bank transfer or cash, a 50% deposit rule that
confirms a pending booking the moment it is met, balances derived from the
payment rows rather than stored, payment screenshots in a private bucket,
duplicate-reference blocking with an audited override, voids, corrections and
refunds that never delete a row, and bilingual printable receipts numbered per
business. OCR, reports, subscriptions and guest-facing pages remain out of scope.

## What is in the box

| Path                   | What it is                                                     |
| ---------------------- | -------------------------------------------------------------- |
| `apps/web`             | Next.js 16 App Router dashboard (React 19, Tailwind v4)         |
| `apps/mobile`          | Expo SDK 57 app (expo-router, React Native 0.86)                |
| `packages/shared`      | Types, zod schemas, roles/permissions, availability, pricing, payments, phone, CSV, i18n |
| `supabase/migrations`  | PostgreSQL schema, RLS policies, storage policies and RPCs      |
| `supabase/tests`       | SQL proof that tenants cannot see each other, plus an HTTP smoke test |
| `docs`                 | Architecture, Supabase setup, per-phase feature and test plans   |

## Requirements

- Node **>= 20.19** (developed on Node 24; `npm test` uses Node's native
  TypeScript type stripping, so no test runner is installed)
- npm 10+ (workspaces)
- [Supabase CLI](https://supabase.com/docs/guides/cli) + Docker, for the local database
- Expo Go or a simulator, for the mobile app

## Install

```bash
git clone <repo> homestay-saas
cd homestay-saas
npm install
```

## Environment

```bash
cp .env.example apps/web/.env.local
cp .env.example apps/mobile/.env
```

Fill in the values printed by `npm run db:start` (or from your Supabase project
dashboard). `.env.example` documents every variable. Nothing secret belongs in
either file — both apps only ever use the anon key.

## Database

```bash
npm run db:start     # start the local Supabase stack (ports are offset, see supabase/config.toml)
npm run db:reset     # apply every migration from scratch
npm run db:push      # push migrations to a linked remote project
```

Steps that cannot be done from code (OAuth providers, SMS provider, redirect
allow-list, SMTP) are listed in [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md).

## Develop

```bash
npm run dev:web      # http://localhost:3000
npm run dev:mobile   # Expo dev server
```

## Verify

```bash
npm run lint         # eslint (flat config, repo-wide)
npm run typecheck    # tsc --noEmit in every workspace
npm test             # shared package unit tests (node --test)
npm run build        # production build of apps/web
npm run db:test      # reset the database, then run all five RLS suites
npm run db:test:sql  # all five RLS suites without resetting
npm run db:smoke     # HTTP smoke test: auth, PostgREST and Storage on a live stack
```

`npm run db:test` needs `SUPABASE_DB_URL` exported; `npm run db:smoke` needs
`SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (see `.env.example` and
`npx supabase status`). The smoke test is the only check that exercises Storage
and PostgREST's schema cache, so run it before shipping a schema change.

Manual checks and the alternative way to run the SQL suites against plain
PostgreSQL are in [docs/PHASE_1_TESTING.md](docs/PHASE_1_TESTING.md),
[docs/PHASE_2_TESTING.md](docs/PHASE_2_TESTING.md),
[docs/PHASE_3_TESTING.md](docs/PHASE_3_TESTING.md),
[docs/PHASE_4_TESTING.md](docs/PHASE_4_TESTING.md) and
[docs/PHASE_5_TESTING.md](docs/PHASE_5_TESTING.md).

## Security model in one paragraph

Every tenant table has RLS enabled and `anon`/`authenticated` privileges are
revoked and re-granted narrowly. Membership and permission checks live in
`SECURITY DEFINER` functions, and anything multi-step (creating a business,
changing a role, removing a member, creating a property, archiving one, archiving a customer, importing or
exporting customers) is an
RPC that derives the caller from `auth.uid()`. Property photos, prices and
blocks carry the owning `business_id` on the row and are constrained to their
property by a composite foreign key, so their policies re-check membership
instead of trusting the parent. Photo objects live in a **private** bucket whose
policies parse the tenant prefix out of the object key. Customers and their
internal notes are tenanted the same way, archived rather than deleted, and
their normalized phone numbers are derived by a database trigger rather than
accepted from a client — so no forged value can hide a record from duplicate
detection. Bookings go further: they are created and edited **only** through
`save_booking`, which takes a per-property advisory lock before scanning for
conflicts so two simultaneous requests cannot both win, and the only columns a
client may `UPDATE` directly are the two note fields. Conflict and price
overrides are permissions checked inside that RPC, each demanding a reason and
recording who approved it. Booking numbers come from a counter keyed by
business, unreadable to any client, so they leak nothing across tenants. Payments
are the strictest of all: `authenticated` holds **no UPDATE and no DELETE** on
`payments`, `payment_proofs`, `payment_adjustments` or `receipts`, so voiding,
correcting and refunding exist only as definer RPCs that demand a reason and
write an audit row — a financial record is never destroyed, only superseded.
Every balance is recomputed from those rows rather than stored, so there is no
number a client could edit. No client ever sends a role or a business id it chose
itself; the payment RPCs do not accept a business id at all. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

| Doc                                                     | Covers                                               |
| ------------------------------------------------------- | ---------------------------------------------------- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)                 | Layout, data model, authorization, conventions       |
| [SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md)             | Migrations and everything that must be clicked once  |
| [PHASE_1_TESTING.md](docs/PHASE_1_TESTING.md)           | Auth, onboarding and tenant-isolation test plan      |
| [PHASE_2_PROPERTIES.md](docs/PHASE_2_PROPERTIES.md)     | Properties, pricing, photos, blocks, availability    |
| [PHASE_2_TESTING.md](docs/PHASE_2_TESTING.md)           | Phase 2 test plan and recorded results               |
| [PHASE_3_CUSTOMERS.md](docs/PHASE_3_CUSTOMERS.md)       | Customers, phone normalization, notes, import/export |
| [PHASE_3_TESTING.md](docs/PHASE_3_TESTING.md)           | Phase 3 test plan and recorded results               |
| [PHASE_4_BOOKINGS.md](docs/PHASE_4_BOOKINGS.md)         | Bookings, calendar, pricing, conflicts, pending holds |
| [PHASE_4_TESTING.md](docs/PHASE_4_TESTING.md)           | Phase 4 test plan and recorded results               |
| [PHASE_5_PAYMENTS.md](docs/PHASE_5_PAYMENTS.md)         | Payments, deposits, balances, refunds, proofs, receipts |
| [PHASE_5_TESTING.md](docs/PHASE_5_TESTING.md)           | Phase 5 test plan and recorded results               |
