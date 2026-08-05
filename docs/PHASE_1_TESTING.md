# Phase 1 testing

Everything below was run before Phase 1 was declared complete. Commands are
exact; run them from the repository root.

## 1. Automated checks

```bash
npm install
npm run lint         # eslint, flat config, all workspaces
npm run typecheck    # tsc --noEmit in shared, mobile and web
npm test             # node --test over packages/shared
npm run build        # next build for apps/web
```

`npm run build` reads `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` at module load. For a build-only check without
a database:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331 \
NEXT_PUBLIC_SUPABASE_ANON_KEY=build-check \
npm run build
```

Expo config check:

```bash
cd apps/mobile && npx expo config --type public
```

It must resolve `scheme: "homestay"`, `sdkVersion: "57.0.0"` and
`plugins: ["expo-router"]`. A missing scheme means OAuth deep links will not
return to the app.

### What `npm test` covers

`packages/shared/src/i18n/i18n.test.ts`

- every English key has a Khmer translation and vice versa
- no Khmer value was left as untranslated English
- Khmer strings actually contain Khmer script
- interpolation replaces named vars and leaves unknown ones alone
- `resolveLocale` falls back instead of trusting input

`packages/shared/src/roles.test.ts`

- **the TypeScript permission matrix matches the `role_permissions` seed in
  SQL** — this test parses `20260804000200_security_functions.sql`, so UI
  permissions cannot silently drift from enforced ones
- `can()` reflects the role hierarchy
- `canManageMember` blocks self-service and privilege escalation

## 2. SQL tenant isolation suite

`supabase/tests/rls_isolation.sql` is the proof that one business cannot see
another. It runs inside a transaction that is **rolled back**, so it is safe
against a populated database, and it aborts on the first failed assertion.

### Against the local Supabase stack

```bash
export SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54332/postgres
npm run db:test
```

(`db:test` = `supabase db reset` followed by the psql run below.)

To run the suite without resetting:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_isolation.sql
```

### Against a bare PostgreSQL instance (CI, or no Docker stack)

The migrations reference `auth.uid()` and the `anon` / `authenticated` /
`service_role` roles. `supabase/tests/auth_stub.sql` supplies just those
pieces. **Never load it against a real Supabase database** — it would downgrade
the real `auth` schema.

```bash
export PGURL=postgresql://postgres:postgres@127.0.0.1:5432
createdb -h 127.0.0.1 -U postgres homestay_phase1_test

psql "$PGURL/homestay_phase1_test" -v ON_ERROR_STOP=1 \
  -f supabase/tests/auth_stub.sql \
  -f supabase/migrations/20260804000100_core_schema.sql \
  -f supabase/migrations/20260804000200_security_functions.sql \
  -f supabase/migrations/20260804000300_rls_policies.sql \
  -f supabase/migrations/20260804000400_rpc.sql

psql "$PGURL/homestay_phase1_test" -v ON_ERROR_STOP=1 \
  -f supabase/tests/rls_isolation.sql

dropdb -h 127.0.0.1 -U postgres homestay_phase1_test
```

### Expected output

The last row printed is:

```
             result
--------------------------------
 ALL RLS ISOLATION TESTS PASSED
```

Anything else — a `psql` non-zero exit, an assertion notice — is a failure.
`assert_rejected` re-raises its own assertion errors, so a statement that was
supposed to be blocked but succeeded cannot be mistaken for a pass.

### The fixture: two unrelated businesses

| Business | Members                                      |
| -------- | -------------------------------------------- |
| ALPHA    | alice (owner), mark (manager), sam (staff)   |
| BETA     | bella (owner), stan (staff)                  |

Both businesses are created through `create_business()` as the respective
owner, exactly as the app does it. Each section sets
`request.jwt.claims` and `set local role authenticated`, which is what
`auth.uid()` reads — the same code path as a real request.

| # | Section                | Asserts                                                                                   |
| - | ---------------------- | ----------------------------------------------------------------------------------------- |
| 1 | Tenant isolation       | ALPHA members see zero BETA rows in `businesses`, `business_members`, `business_settings`; `current_business_context()` resolves to their own business; mirrored from BETA's side |
| 2 | Member visibility      | owner and manager read active members; **staff cannot**                                     |
| 3 | Write authorization    | manager cannot rename the business or change settings; nobody writes `business_members` directly; businesses cannot be created outside the RPC; soft delete is not reachable via UPDATE; owner *can* rename |
| 4 | Role management RPCs   | staff cannot change roles; managers cannot change roles or remove a manager/owner; owners cannot promote themselves and cannot act on another tenant; a legitimate owner-driven promotion succeeds |
| 5 | `user_preferences`     | a user cannot point `last_business_id` at a business they do not belong to, and cannot update another user's row (asserted on effect, since RLS filters rather than raises) |
| 6 | Anonymous callers      | `anon` reads nothing — privileges are revoked outright, so it fails before RLS is consulted |
| 7 | Soft delete            | a soft-deleted business disappears for its own members and stops being the active context   |

## 3. HTTP smoke test against a real stack

The SQL suite proves the policy matrix by setting JWT claims directly. It never
touches GoTrue or PostgREST, so it cannot see anything that lives in the layer
above SQL. This one does:

```bash
export SUPABASE_ANON_KEY=...          # both from `npx supabase status`
export SUPABASE_SERVICE_ROLE_KEY=...
npm run db:smoke
```

It creates users, so it refuses to run unless `SUPABASE_URL` (default
`http://127.0.0.1:54331`) is loopback. It cleans up the users it makes, and
cascades take their businesses with them.

Sixteen checks, in four groups:

| Group             | Asserts                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Auth              | a real password grant returns an access token; a phone OTP request is accepted and verification returns a session                         |
| Signup trigger    | `handle_new_user` created exactly one profile, visible only to its owner, carrying `full_name` from user metadata; `user_preferences` provisioned |
| Isolation over HTTP | two businesses created through the RPC; each owner sees only their own; naming another tenant's id returns nothing; membership rows never cross; the team query can embed `profiles`; `current_business_context` resolves correctly |
| Refused writes    | an owner cannot `set_member_role` on themselves, cannot soft-delete another tenant's business, cannot insert membership directly; the anon key alone reads no tenant data |

Two of these exist because running against a real stack caught what SQL alone
could not:

- **the phone OTP checks** — the test number was configured but unreachable,
  because GoTrue disables phone login entirely when no SMS provider is enabled.
- **the profile embed check** — `business_members.user_id` referenced
  `auth.users`, so PostgREST had no relationship to embed `profiles(...)`
  through and the settings page 500'd. The SQL suite queries the tables
  directly and never saw it.

Last line printed is `ALL SUPABASE SMOKE TESTS PASSED`; the process exits
non-zero otherwise.

## 4. Manual checks

These need a running database and cannot be asserted in SQL.

### Protected routes (web)

1. Sign out, open `http://localhost:3000/dashboard` → redirected to
   `/sign-in?next=/dashboard`.
2. Sign in → you land on `/dashboard`, not the home page.
3. While signed in, open `/sign-in` → redirected to `/dashboard`.
4. `/reset-password` stays reachable while signed in — the recovery link signs
   you in *before* you choose a new password.
5. Sign out in one tab, reload another → the second tab redirects too.

Try the same by editing the session cookie: an invalid token is rejected
because `src/proxy.ts` uses `getUser()` (which revalidates) rather than
`getSession()` (which does not).

### Onboarding gate

A user with no business is pushed to `/onboarding` from anywhere in `(app)`;
after creating one they land on `/dashboard`, the header shows the business
name and their role badge, and `/onboarding` then redirects away.

### Session restoration (mobile)

Sign in, force-quit the app, reopen → the app goes straight to the tabs
without a sign-in screen. Background the app for longer than the token
lifetime, foreground it → still signed in (`AppState` restarts auto-refresh).

### Language

Switch to ខ្មែរ in Settings on either app. Every visible string changes,
Khmer glyphs render with correct stacked diacritics (not boxes), the choice
survives a reload, and the *other* app picks it up after its next sign-in —
the preference is stored in `user_preferences`, not only on the device.

### Permissions in the UI

Sign in as staff: the Team panel in Settings shows the "restricted" message
instead of the member list, because `getActiveMembers()` returns null when
`can(role, 'members.read')` is false. Removing that check client-side changes
nothing — section 2 of the SQL suite proves the database refuses the read.

## 5. Results at the close of Phase 1

| Check                              | Result                                                       |
| ---------------------------------- | ------------------------------------------------------------ |
| `npm install`                      | 706 packages, no vulnerabilities reported                     |
| `npm run lint`                     | clean (2 `no-console` warnings in the smoke test, which prints its results by design) |
| `npm run typecheck`                | clean in shared, mobile, web                                  |
| `npm test`                         | 8/8 passing                                                   |
| `npm run build`                    | compiled successfully, 18 routes, all dynamic, proxy attached |
| `npx expo config --type public`    | resolves scheme `homestay`, SDK 57, expo-router               |
| `rls_isolation.sql`                | `ALL RLS ISOLATION TESTS PASSED`                              |
| `npm run db:smoke`                 | 16/16 against real GoTrue + PostgREST                         |

Everything above was re-run against a real Supabase stack (the CLI's own
GoTrue, PostgREST and Studio containers) rather than bare PostgreSQL, which is
what surfaced the two defects noted in section 3.

> These numbers describe Phase 1 in isolation. Once Phase 2 lands, `npm test`
> and `npm run typecheck` will report Phase 2 work too — a missing Khmer
> translation for a new English key fails the i18n parity test by design, and
> `km.ts` not satisfying the key type fails `tsc`. Both are the guards working,
> not regressions in Phase 1.
