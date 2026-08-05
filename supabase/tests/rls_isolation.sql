-- =============================================================================
-- Tenant isolation test suite.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_isolation.sql
--
-- Runs inside a transaction that is ROLLED BACK, so it is safe against a
-- populated database. Exits non-zero on the first failed assertion.
--
-- Fixture users below are literal UUIDs on purpose: they exist only inside this
-- rolled-back transaction and never reach application code.
-- =============================================================================

\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if p_condition is distinct from true then
    raise exception 'ASSERTION FAILED: %', p_message using errcode = 'ASRT1';
  end if;
end;
$$;

-- Asserts that a statement is rejected. Re-raises our own assertion errors so a
-- silent pass is impossible.
create or replace function pg_temp.assert_rejected(p_sql text, p_message text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception
    when sqlstate 'ASRT1' then raise;
    when others then return;                -- rejected as expected
  end;
  raise exception 'ASSERTION FAILED: % (statement succeeded)', p_message
    using errcode = 'ASRT1';
end;
$$;

grant execute on function pg_temp.assert(boolean, text) to public;
grant execute on function pg_temp.assert_rejected(text, text) to public;

-- ---------------------------------------------------------------------------
-- Fixtures: two unrelated businesses, five users.
--   Business ALPHA : alice (owner), mark (manager), sam (staff)
--   Business BETA  : bella (owner), stan (staff)
-- ---------------------------------------------------------------------------
\set alice '\'aaaaaaaa-0000-4000-8000-000000000001\''
\set mark  '\'aaaaaaaa-0000-4000-8000-000000000002\''
\set sam   '\'aaaaaaaa-0000-4000-8000-000000000003\''
\set bella '\'bbbbbbbb-0000-4000-8000-000000000001\''
\set stan  '\'bbbbbbbb-0000-4000-8000-000000000002\''

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
values
  (:alice::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'alice@alpha.test', 'x', now(), now(), now(), '{}'::jsonb, '{"full_name":"Alice Owner"}'::jsonb),
  (:mark::uuid,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'mark@alpha.test', 'x', now(), now(), now(), '{}'::jsonb, '{"full_name":"Mark Manager"}'::jsonb),
  (:sam::uuid,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'sam@alpha.test', 'x', now(), now(), now(), '{}'::jsonb, '{"full_name":"Sam Staff"}'::jsonb),
  (:bella::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'bella@beta.test', 'x', now(), now(), now(), '{}'::jsonb, '{"full_name":"Bella Owner"}'::jsonb),
  (:stan::uuid,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'stan@beta.test', 'x', now(), now(), now(), '{}'::jsonb, '{"full_name":"Stan Staff"}'::jsonb);

-- The signup trigger must have provisioned profile + preferences rows.
select pg_temp.assert(
  (select count(*) from public.profiles where id in (:alice::uuid, :bella::uuid)) = 2,
  'handle_new_user did not create profiles');
select pg_temp.assert(
  (select count(*) from public.user_preferences where user_id in (:alice::uuid, :bella::uuid)) = 2,
  'handle_new_user did not create user_preferences');

-- --- Business ALPHA, created through the RPC as Alice ----------------------
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as alpha_id from public.create_business(
  'Alpha Homestay', 'Alice Owner', '+85512000001', 'km', 'KHR', 'Asia/Phnom_Penh') \gset
reset role;

-- --- Business BETA, created through the RPC as Bella -----------------------
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as beta_id from public.create_business(
  'Beta Villas', 'Bella Owner', '+85512000002', 'en', 'USD', 'Asia/Bangkok') \gset
reset role;

-- Phase 1 has no invitation flow yet, so the remaining memberships are seeded
-- directly (as the table owner) to set up the authorisation matrix.
insert into public.business_members (business_id, user_id, role, status) values
  (:'alpha_id'::uuid, :mark::uuid,  'manager', 'active'),
  (:'alpha_id'::uuid, :sam::uuid,   'staff',   'active'),
  (:'beta_id'::uuid,  :stan::uuid,  'staff',   'active');

select pg_temp.assert(:'alpha_id'::uuid <> :'beta_id'::uuid, 'fixtures collided');

-- ===========================================================================
-- 1. Tenant isolation — a member of ALPHA sees no trace of BETA
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.assert(
  (select count(*) from public.businesses) = 1,
  'owner of ALPHA can see more than one business');
select pg_temp.assert(
  (select count(*) from public.businesses where id = :'beta_id'::uuid) = 0,
  'owner of ALPHA can read BETA by id');
select pg_temp.assert(
  (select count(*) from public.business_settings where business_id = :'beta_id'::uuid) = 0,
  'owner of ALPHA can read BETA settings');
select pg_temp.assert(
  (select count(*) from public.business_members where business_id = :'beta_id'::uuid) = 0,
  'owner of ALPHA can read BETA members');
select pg_temp.assert(
  (select count(*) from public.profiles where id = :bella::uuid) = 0,
  'owner of ALPHA can read a BETA-only profile');
select pg_temp.assert(
  public.is_business_member(:'beta_id'::uuid) = false,
  'is_business_member leaks across tenants');
select pg_temp.assert(
  public.current_role_in(:'beta_id'::uuid) is null,
  'current_role_in leaks across tenants');

-- current_business_context resolves to the caller's own business
select pg_temp.assert(
  (select business_id from public.current_business_context()) = :'alpha_id'::uuid,
  'current_business_context returned the wrong business');
select pg_temp.assert(
  (select role from public.current_business_context()) = 'owner',
  'creator was not made owner');
select pg_temp.assert(
  (select member_count from public.current_business_context()) = 3,
  'ALPHA member count wrong');
select pg_temp.assert(
  (select default_currency from public.current_business_context()) = 'KHR',
  'business settings not applied');

reset role;

-- The mirror image, from BETA's side.
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  (select count(*) from public.businesses) = 1,
  'owner of BETA can see more than one business');
select pg_temp.assert(
  (select business_id from public.current_business_context()) = :'beta_id'::uuid,
  'BETA owner resolved to the wrong business');
reset role;

-- ===========================================================================
-- 2. Member visibility — owners/managers read active members, staff does not
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  (select count(*) from public.business_members where business_id = :'alpha_id'::uuid) = 3,
  'manager cannot read the active member list');
select pg_temp.assert(
  (select count(*) from public.profiles) = 3,
  'manager cannot read co-member profiles');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  (select count(*) from public.business_members) = 1,
  'staff can read other members');
select pg_temp.assert(
  (select count(*) from public.profiles) = 1,
  'staff can read other profiles');
select pg_temp.assert(
  (select count(*) from public.businesses where id = :'alpha_id'::uuid) = 1,
  'staff cannot see their own business');
reset role;

-- ===========================================================================
-- 3. Write authorisation
-- ===========================================================================

-- Manager may not rename the business (business.update is owner-only).
select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;
update public.businesses set name = 'Hijacked' where id = :'alpha_id'::uuid;
select pg_temp.assert(
  (select name from public.businesses where id = :'alpha_id'::uuid) = 'Alpha Homestay',
  'manager was able to rename the business');

-- Manager may not change business settings.
update public.business_settings set default_currency = 'USD'
  where business_id = :'alpha_id'::uuid;
select pg_temp.assert(
  (select default_currency from public.business_settings where business_id = :'alpha_id'::uuid) = 'KHR',
  'manager was able to change business settings');

-- Nobody writes business_members directly: no INSERT/UPDATE/DELETE policy.
select pg_temp.assert_rejected(
  format('insert into public.business_members (business_id, user_id, role) values (%L, %L, %L)',
         :'alpha_id', :mark, 'owner'),
  'manager inserted a membership row directly');
select pg_temp.assert_rejected(
  format('update public.business_members set role = %L where user_id = %L', 'owner', :mark),
  'manager promoted itself with a direct UPDATE');
select pg_temp.assert_rejected(
  format('delete from public.business_members where business_id = %L', :'alpha_id'),
  'manager deleted memberships directly');

-- Businesses cannot be created outside the RPC.
select pg_temp.assert_rejected(
  'insert into public.businesses (name) values (''Rogue'')',
  'a client inserted a business directly');

-- Soft delete is not reachable through the UPDATE policy.
update public.businesses set deleted_at = now() where id = :'alpha_id'::uuid;
select pg_temp.assert(
  (select deleted_at from public.businesses where id = :'alpha_id'::uuid) is null,
  'a client soft-deleted a business through UPDATE');
reset role;

-- Owner may rename.
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
update public.businesses set name = 'Alpha Homestay & Villas' where id = :'alpha_id'::uuid;
select pg_temp.assert(
  (select name from public.businesses where id = :'alpha_id'::uuid) = 'Alpha Homestay & Villas',
  'owner cannot rename their own business');
reset role;

-- ===========================================================================
-- 4. Role management RPCs
-- ===========================================================================

-- Staff cannot change roles.
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_rejected(
  format('select public.set_member_role(%L, %L, %L)', :'alpha_id', :sam, 'owner'),
  'staff promoted itself via RPC');
select pg_temp.assert_rejected(
  format('select public.remove_member(%L, %L)', :'alpha_id', :mark),
  'staff removed a manager via RPC');
reset role;

-- Managers cannot change roles, and cannot remove a manager or owner.
select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_rejected(
  format('select public.set_member_role(%L, %L, %L)', :'alpha_id', :sam, 'manager'),
  'manager changed a role via RPC');
select pg_temp.assert_rejected(
  format('select public.remove_member(%L, %L)', :'alpha_id', :alice),
  'manager removed the owner');
reset role;

-- Owners cannot promote themselves, and cannot act on another tenant.
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_rejected(
  format('select public.set_member_role(%L, %L, %L)', :'alpha_id', :alice, 'owner'),
  'owner edited their own membership row');
select pg_temp.assert_rejected(
  format('select public.set_member_role(%L, %L, %L)', :'beta_id', :stan, 'owner'),
  'ALPHA owner changed a role inside BETA');
select pg_temp.assert_rejected(
  format('select public.remove_member(%L, %L)', :'beta_id', :stan),
  'ALPHA owner removed a BETA member');
select pg_temp.assert_rejected(
  format('select public.soft_delete_business(%L)', :'beta_id'),
  'ALPHA owner deleted BETA');

-- Owner promoting an actual member works.
select public.set_member_role(:'alpha_id'::uuid, :sam::uuid, 'manager');
select pg_temp.assert(
  (select role from public.business_members
     where business_id = :'alpha_id'::uuid and user_id = :sam::uuid) = 'manager',
  'owner could not promote a staff member');
reset role;

-- Managers may remove staff, but Sam is a manager now, so it must fail.
select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_rejected(
  format('select public.remove_member(%L, %L)', :'alpha_id', :sam),
  'manager removed another manager');
reset role;

-- ===========================================================================
-- 5. user_preferences cannot hold a business the user is not a member of
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_rejected(
  format('update public.user_preferences set last_business_id = %L where user_id = %L',
         :'alpha_id', :bella),
  'a user parked a foreign business id in their preferences');
-- An UPDATE against another user's row is filtered by RLS rather than raising,
-- so assert on the effect: Alice's language must still be the one she chose.
update public.user_preferences set language = 'en' where user_id = :alice::uuid;
reset role;
select pg_temp.assert(
  (select language from public.user_preferences where user_id = :alice::uuid) = 'km',
  'a user edited someone else''s preferences');

-- ===========================================================================
-- 6. Anonymous callers see nothing
-- ===========================================================================
select set_config('request.jwt.claims', '', true);
set local role anon;
-- anon holds no grant at all on tenant tables, so this fails before RLS is even
-- consulted. Defence in depth: revoked privileges *and* restrictive policies.
select pg_temp.assert_rejected(
  'select count(*) from public.businesses',
  'anon can read businesses');
select pg_temp.assert_rejected(
  'select count(*) from public.business_members',
  'anon can read memberships');
reset role;

-- ===========================================================================
-- 7. Soft delete hides the business from its own members
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
select public.soft_delete_business(:'beta_id'::uuid);
select pg_temp.assert(
  (select count(*) from public.businesses) = 0,
  'soft-deleted business is still visible');
select pg_temp.assert(
  (select count(*) from public.current_business_context()) = 0,
  'soft-deleted business is still the active context');
reset role;

select 'ALL RLS ISOLATION TESTS PASSED' as result;

rollback;
