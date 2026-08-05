-- =============================================================================
-- Phase 2 tenant isolation suite: properties, photos, pricing and blocks.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_properties.sql
--
-- Same shape as rls_isolation.sql: one rolled-back transaction, two unrelated
-- businesses, five users, and an assertion helper that cannot pass silently.
--
-- Two businesses are the point of the file. Every read test is asserted from
-- both sides, so a policy that leaks in one direction still fails here.
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
-- Fixtures
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

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as alpha_id from public.create_business(
  'Alpha Homestay', 'Alice Owner', '+85512000001', 'km', 'KHR', 'Asia/Phnom_Penh') \gset
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as beta_id from public.create_business(
  'Beta Villas', 'Bella Owner', '+85512000002', 'en', 'USD', 'Asia/Bangkok') \gset
reset role;

insert into public.business_members (business_id, user_id, role, status) values
  (:'alpha_id'::uuid, :mark::uuid, 'manager', 'active'),
  (:'alpha_id'::uuid, :sam::uuid,  'staff',   'active'),
  (:'beta_id'::uuid,  :stan::uuid, 'staff',   'active');

-- ===========================================================================
-- 1. Creation goes through the RPC, and it creates the base price with it
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as alpha_prop from public.create_property(
  :'alpha_id'::uuid, 'Alpha Riverside Villa', 45, 60, 'USD') \gset

select pg_temp.assert(
  (select count(*) from public.property_pricing
     where property_id = :'alpha_prop'::uuid and rule_type = 'base') = 1,
  'create_property did not create the base pricing row');
select pg_temp.assert(
  (select created_by from public.properties where id = :'alpha_prop'::uuid) = :alice::uuid,
  'create_property did not stamp created_by with the caller');

-- Currency falls back to the business default when the client omits it.
select id as alpha_prop2 from public.create_property(
  :'alpha_id'::uuid, 'Alpha Garden House', 30, 40) \gset
select pg_temp.assert(
  (select currency from public.property_pricing where property_id = :'alpha_prop2'::uuid) = 'KHR',
  'create_property ignored the business default currency');

-- A live name may not repeat inside one business.
select pg_temp.assert_rejected(
  format('select public.create_property(%L, %L, 10, 10)', :'alpha_id', 'alpha riverside VILLA '),
  'duplicate live property name accepted');

-- A photo and a block to hang the child-table tests on.
insert into public.property_photos (business_id, property_id, storage_path, mime_type, is_cover, created_by)
values (:'alpha_id'::uuid, :'alpha_prop'::uuid,
        'businesses/' || :'alpha_id' || '/properties/' || :'alpha_prop' || '/cover.jpg',
        'image/jpeg', true, :alice::uuid)
returning id as alpha_photo \gset

insert into public.property_blocks (business_id, property_id, starts_at, ends_at, reason, created_by)
values (:'alpha_id'::uuid, :'alpha_prop'::uuid,
        '2026-09-01 14:00+07', '2026-09-05 12:00+07', 'maintenance', :alice::uuid)
returning id as alpha_block \gset
reset role;

-- BETA gets one property of its own, so "0 rows" can never be a false pass.
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as beta_prop from public.create_property(
  :'beta_id'::uuid, 'Beta Beach House', 80, 110, 'USD') \gset
insert into public.property_photos (business_id, property_id, storage_path, mime_type, created_by)
values (:'beta_id'::uuid, :'beta_prop'::uuid,
        'businesses/' || :'beta_id' || '/properties/' || :'beta_prop' || '/beach.webp',
        'image/webp', :bella::uuid);
reset role;

-- ===========================================================================
-- 2. Cross-tenant reads — asserted from both sides
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  (select count(*) from public.properties) = 2,
  'ALPHA owner sees a property count that is not ALPHA''s');
select pg_temp.assert(
  (select count(*) from public.properties where id = :'beta_prop'::uuid) = 0,
  'ALPHA owner can read a BETA property by id');
select pg_temp.assert(
  (select count(*) from public.property_photos where business_id = :'beta_id'::uuid) = 0,
  'ALPHA owner can read BETA photos');
select pg_temp.assert(
  (select count(*) from public.property_pricing where business_id = :'beta_id'::uuid) = 0,
  'ALPHA owner can read BETA pricing');
select pg_temp.assert(
  (select count(*) from public.property_blocks where business_id = :'beta_id'::uuid) = 0,
  'ALPHA owner can read BETA blocks');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :stan, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  (select count(*) from public.properties) = 1,
  'BETA staff sees properties outside BETA');
select pg_temp.assert(
  (select count(*) from public.properties where id = :'alpha_prop'::uuid) = 0,
  'BETA staff can read an ALPHA property by id');
select pg_temp.assert(
  (select count(*) from public.property_photos where id = :'alpha_photo'::uuid) = 0,
  'BETA staff can read an ALPHA photo');
select pg_temp.assert(
  (select count(*) from public.property_blocks where id = :'alpha_block'::uuid) = 0,
  'BETA staff can read an ALPHA block');
reset role;

-- ===========================================================================
-- 3. Cross-tenant writes — a client-supplied business_id buys nothing
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.assert_rejected(
  format('select public.create_property(%L, %L, 10, 10)', :'alpha_id', 'Hijacked'),
  'BETA owner created a property inside ALPHA');
select pg_temp.assert_rejected(
  format('insert into public.properties (business_id, name) values (%L, %L)',
         :'alpha_id', 'Hijacked Direct'),
  'BETA owner inserted a property row into ALPHA');
select pg_temp.assert_rejected(
  format($f$insert into public.property_photos
            (business_id, property_id, storage_path, mime_type)
            values (%L, %L, %L, 'image/jpeg')$f$,
         :'alpha_id', :'alpha_prop',
         'businesses/' || :'alpha_id' || '/properties/' || :'alpha_prop' || '/stolen.jpg'),
  'BETA owner attached a photo to an ALPHA property');
select pg_temp.assert_rejected(
  format($f$insert into public.property_pricing
            (business_id, property_id, weekday_price, weekend_price, currency)
            values (%L, %L, 1, 1, 'USD')$f$, :'alpha_id', :'alpha_prop'),
  'BETA owner priced an ALPHA property');
select pg_temp.assert_rejected(
  format($f$insert into public.property_blocks
            (business_id, property_id, starts_at, ends_at, reason)
            values (%L, %L, now(), now() + interval '1 day', 'custom')$f$,
         :'alpha_id', :'alpha_prop'),
  'BETA owner blocked an ALPHA property');
select pg_temp.assert_rejected(
  format('select public.set_property_archived(%L)', :'alpha_prop'),
  'BETA owner archived an ALPHA property');
select pg_temp.assert_rejected(
  format('select public.set_property_cover_photo(%L)', :'alpha_photo'),
  'BETA owner changed an ALPHA cover photo');

-- Relabelling BETA's own child row with ALPHA's id must fail on the composite
-- FK even before the policy is consulted.
select pg_temp.assert_rejected(
  format($f$insert into public.property_photos
            (business_id, property_id, storage_path, mime_type)
            values (%L, %L, 'businesses/x/properties/y/z.jpg', 'image/jpeg')$f$,
         :'beta_id', :'alpha_prop'),
  'a photo referenced a foreign property through a mismatched business_id');

-- Updates that fail USING are filtered, not raised, so assert on the effect.
update public.properties set name = 'Renamed by BETA' where id = :'alpha_prop'::uuid;
update public.property_pricing set weekday_price = 1 where property_id = :'alpha_prop'::uuid;
update public.property_blocks set status = 'cancelled' where id = :'alpha_block'::uuid;
delete from public.property_photos where id = :'alpha_photo'::uuid;
reset role;

select pg_temp.assert(
  (select name from public.properties where id = :'alpha_prop'::uuid) = 'Alpha Riverside Villa',
  'BETA owner renamed an ALPHA property');
select pg_temp.assert(
  (select weekday_price from public.property_pricing where property_id = :'alpha_prop'::uuid) = 45,
  'BETA owner repriced an ALPHA property');
select pg_temp.assert(
  (select status from public.property_blocks where id = :'alpha_block'::uuid) = 'active',
  'BETA owner cancelled an ALPHA block');
select pg_temp.assert(
  (select count(*) from public.property_photos where id = :'alpha_photo'::uuid) = 1,
  'BETA owner deleted an ALPHA photo');

-- ===========================================================================
-- 4. Storage keys are tenant-isolated by the same permission matrix
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  public.can_access_property_object(
    'businesses/' || :'alpha_id' || '/properties/' || :'alpha_prop' || '/cover.jpg',
    'properties.photos.manage'),
  'ALPHA owner cannot write into their own storage prefix');
select pg_temp.assert(
  public.can_access_property_object(
    'businesses/' || :'beta_id' || '/properties/' || :'beta_prop' || '/beach.webp',
    'properties.read') = false,
  'ALPHA owner can read a BETA storage object');
-- A key that does not match the layout is refused rather than raising.
select pg_temp.assert(
  public.can_access_property_object('../../etc/passwd', 'properties.read') = false,
  'a malformed storage key was accepted');
select pg_temp.assert(
  public.can_access_property_object(
    'businesses/' || :'alpha_id' || '/properties/', 'properties.read') = false,
  'a storage key with no file name was accepted');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  public.can_access_property_object(
    'businesses/' || :'alpha_id' || '/properties/' || :'alpha_prop' || '/cover.jpg',
    'properties.read'),
  'staff cannot read their own tenant''s storage objects');
select pg_temp.assert(
  public.can_access_property_object(
    'businesses/' || :'alpha_id' || '/properties/' || :'alpha_prop' || '/cover.jpg',
    'properties.photos.manage') = false,
  'staff can upload storage objects');
reset role;

-- The metadata row must describe an object inside its own prefix, so a photo
-- cannot point at another tenant's bytes.
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_rejected(
  format($f$insert into public.property_photos
            (business_id, property_id, storage_path, mime_type)
            values (%L, %L, %L, 'image/jpeg')$f$,
         :'alpha_id', :'alpha_prop',
         'businesses/' || :'beta_id' || '/properties/' || :'beta_prop' || '/beach.webp'),
  'a photo row pointed at another tenant''s storage path');
select pg_temp.assert_rejected(
  format($f$insert into public.property_photos
            (business_id, property_id, storage_path, mime_type, created_by)
            values (%L, %L, %L, 'image/jpeg', %L)$f$,
         :'alpha_id', :'alpha_prop',
         'businesses/' || :'alpha_id' || '/properties/' || :'alpha_prop' || '/spoof.jpg', :mark),
  'created_by was forged on a photo');
select pg_temp.assert_rejected(
  format($f$insert into public.property_photos
            (business_id, property_id, storage_path, mime_type)
            values (%L, %L, %L, 'application/pdf')$f$,
         :'alpha_id', :'alpha_prop',
         'businesses/' || :'alpha_id' || '/properties/' || :'alpha_prop' || '/doc.pdf'),
  'a non-image mime type was accepted');
reset role;

-- ===========================================================================
-- 5. Role matrix inside one business
-- ===========================================================================

-- Staff: read everything, change nothing.
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  (select count(*) from public.properties) = 2,
  'staff cannot read their own business properties');
select pg_temp.assert(
  (select count(*) from public.property_pricing) = 2,
  'staff cannot read pricing');
select pg_temp.assert(
  (select count(*) from public.property_blocks) = 1,
  'staff cannot read blocks');

select pg_temp.assert_rejected(
  format('select public.create_property(%L, %L, 10, 10)', :'alpha_id', 'Staff Property'),
  'staff created a property');
select pg_temp.assert_rejected(
  format('select public.set_property_archived(%L)', :'alpha_prop'),
  'staff archived a property');
select pg_temp.assert_rejected(
  format('select public.set_property_cover_photo(%L)', :'alpha_photo'),
  'staff changed the cover photo');
select pg_temp.assert_rejected(
  format($f$insert into public.property_blocks
            (business_id, property_id, starts_at, ends_at, reason)
            values (%L, %L, now(), now() + interval '1 day', 'custom')$f$,
         :'alpha_id', :'alpha_prop'),
  'staff created a block');
select pg_temp.assert_rejected(
  format($f$insert into public.property_pricing
            (business_id, property_id, rule_type, weekday_price, weekend_price, currency)
            values (%L, %L, 'base', 1, 1, 'USD')$f$, :'alpha_id', :'alpha_prop2'),
  'staff inserted a pricing row');
-- Properties are never deleted, by anyone: there is no DELETE grant.
select pg_temp.assert_rejected(
  format('delete from public.properties where id = %L', :'alpha_prop'),
  'staff deleted a property');

update public.properties set name = 'Staff Rename' where id = :'alpha_prop'::uuid;
update public.property_pricing set weekday_price = 5 where property_id = :'alpha_prop'::uuid;
update public.properties set is_active = false where id = :'alpha_prop'::uuid;
delete from public.property_photos where id = :'alpha_photo'::uuid;
reset role;

select pg_temp.assert(
  (select name from public.properties where id = :'alpha_prop'::uuid) = 'Alpha Riverside Villa',
  'staff renamed a property');
select pg_temp.assert(
  (select weekday_price from public.property_pricing where property_id = :'alpha_prop'::uuid) = 45,
  'staff changed pricing');
select pg_temp.assert(
  (select is_active from public.properties where id = :'alpha_prop'::uuid),
  'staff deactivated a property');
select pg_temp.assert(
  (select count(*) from public.property_photos where id = :'alpha_photo'::uuid) = 1,
  'staff deleted a photo');

-- Manager: create, edit, activate, price, photos, blocks — but never archive.
select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as mark_prop from public.create_property(
  :'alpha_id'::uuid, 'Manager Cottage', 25, 35, 'USD') \gset

update public.properties set is_active = false where id = :'mark_prop'::uuid;
select pg_temp.assert(
  (select is_active from public.properties where id = :'mark_prop'::uuid) = false,
  'manager cannot deactivate a property');

update public.property_pricing set weekend_price = 39 where property_id = :'mark_prop'::uuid;
select pg_temp.assert(
  (select weekend_price from public.property_pricing where property_id = :'mark_prop'::uuid) = 39,
  'manager cannot change pricing');

insert into public.property_blocks (business_id, property_id, starts_at, ends_at, reason, created_by)
values (:'alpha_id'::uuid, :'mark_prop'::uuid,
        '2026-10-01 00:00+07', '2026-10-03 00:00+07', 'renovation', :mark::uuid);
select pg_temp.assert(
  (select count(*) from public.property_blocks where property_id = :'mark_prop'::uuid) = 1,
  'manager cannot create a block');

select pg_temp.assert_rejected(
  format('select public.set_property_archived(%L)', :'mark_prop'),
  'manager archived a property');

-- archived_at is not reachable through the UPDATE policy either. The row is
-- visible to USING, so this trips WITH CHECK and raises rather than filtering.
select pg_temp.assert_rejected(
  format('update public.properties set archived_at = now() where id = %L', :'mark_prop'),
  'manager archived a property through a plain UPDATE');
select pg_temp.assert(
  (select archived_at from public.properties where id = :'mark_prop'::uuid) is null,
  'archived_at was set through a plain UPDATE');

-- An end before the start is a bug, not a block.
select pg_temp.assert_rejected(
  format($f$insert into public.property_blocks
            (business_id, property_id, starts_at, ends_at, reason)
            values (%L, %L, '2026-10-05 12:00+07', '2026-10-05 09:00+07', 'custom')$f$,
         :'alpha_id', :'mark_prop'),
  'a block ending before it starts was accepted');
select pg_temp.assert_rejected(
  format($f$insert into public.property_blocks
            (business_id, property_id, starts_at, ends_at, reason)
            values (%L, %L, '2026-10-05 12:00+07', '2026-10-05 12:00+07', 'custom')$f$,
         :'alpha_id', :'mark_prop'),
  'a zero-length block was accepted');
-- Blocks are cancelled, never erased: no DELETE grant.
select pg_temp.assert_rejected(
  format('delete from public.property_blocks where property_id = %L', :'mark_prop'),
  'manager deleted a block');
reset role;

-- ===========================================================================
-- 6. Archiving is the delete, and it hides the property
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select public.set_property_archived(:'alpha_prop2'::uuid);
select pg_temp.assert(
  (select count(*) from public.properties where id = :'alpha_prop2'::uuid) = 0,
  'an archived property is still visible');
-- Freed name: archiving must not keep the unique index occupied.
select id as revived from public.create_property(
  :'alpha_id'::uuid, 'Alpha Garden House', 30, 40) \gset
select pg_temp.assert(:'revived'::uuid <> :'alpha_prop2'::uuid, 'fixtures collided');
reset role;

-- The row survives for Phase 4 booking history; only the policy hides it.
select pg_temp.assert(
  (select is_active from public.properties where id = :'alpha_prop2'::uuid) = false,
  'archiving left the property active');

-- ===========================================================================
-- 7. Anonymous callers see nothing
-- ===========================================================================
select set_config('request.jwt.claims', '', true);
set local role anon;
select pg_temp.assert_rejected(
  'select count(*) from public.properties', 'anon can read properties');
select pg_temp.assert_rejected(
  'select count(*) from public.property_photos', 'anon can read property photos');
select pg_temp.assert_rejected(
  'select count(*) from public.property_pricing', 'anon can read pricing');
select pg_temp.assert_rejected(
  'select count(*) from public.property_blocks', 'anon can read blocks');
select pg_temp.assert_rejected(
  format('select public.create_property(%L, %L, 10, 10)', :'alpha_id', 'Anon Property'),
  'anon created a property');
select pg_temp.assert_rejected(
  format('select public.can_access_property_object(%L, %L)', 'businesses/x/y', 'properties.read'),
  'anon can call the storage authorisation helper');
reset role;

select 'ALL PROPERTY RLS TESTS PASSED' as result;

rollback;
