-- =============================================================================
-- Phase 3 tenant isolation suite: customers and internal customer notes.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_customers.sql
--
-- Same shape as rls_isolation.sql and rls_properties.sql: one rolled-back
-- transaction, two unrelated businesses, five users, and an assertion helper
-- that cannot pass silently.
--
-- Both businesses hold customers of their own, so "I saw 0 rows" can never be
-- a false pass: every cross-tenant read is asserted against a business that
-- demonstrably has data.
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
-- 1. normalize_phone() agrees with packages/shared/src/phone.ts
--
-- The same table the TS unit tests use. If the two implementations ever drift,
-- a customer typed on the web would not match the same customer typed on
-- mobile, and duplicate detection would quietly stop working.
-- ===========================================================================
select pg_temp.assert(
  not exists (
    select 1
    from (values
      ('012345678',          '+85512345678'),
      ('012 345 678',        '+85512345678'),
      ('012-345-678',        '+85512345678'),
      ('(012) 345 678',      '+85512345678'),
      ('+855 12 345 678',    '+85512345678'),
      ('+855 (0)12 345 678', '+85512345678'),
      ('85512345678',        '+85512345678'),
      ('0085512345678',      '+85512345678'),
      ('12345678',           '+85512345678'),
      ('077123456',          '+85577123456'),
      ('+66812345678',       '+66812345678'),
      ('(+66) 81 234 5678',  '+66812345678'),
      ('0066812345678',      '+66812345678'),
      ('0855123456',         '+855855123456'),
      ('not a phone',        null),
      ('+',                  null),
      ('',                   null)
    ) as t(input, expected)
    where public.normalize_phone(t.input) is distinct from t.expected
  ),
  'normalize_phone() disagrees with packages/shared/src/phone.ts');

select pg_temp.assert(public.normalize_phone(null) is null,
  'normalize_phone(null) is not null');

-- ===========================================================================
-- 2. Staff may create and correct customers; the database derives the
--    normalised number, so a client cannot forge one
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;

insert into public.customers (business_id, full_name, phone, phone_secondary, created_by)
values (:'alpha_id'::uuid, 'សុខ ដារា', '012 345 678', '+855 77 123 456', :sam::uuid)
returning id as sok_id \gset

select pg_temp.assert(
  (select normalized_phone from public.customers where id = :'sok_id'::uuid) = '+85512345678',
  'normalized_phone was not derived from the typed number');
select pg_temp.assert(
  (select normalized_phone_secondary from public.customers where id = :'sok_id'::uuid)
    = '+85577123456',
  'the secondary number was not normalised');
select pg_temp.assert(
  (select phone from public.customers where id = :'sok_id'::uuid) = '012 345 678',
  'the typed number was not preserved for display');
select pg_temp.assert(
  (select full_name from public.customers where id = :'sok_id'::uuid) = 'សុខ ដារា',
  'Khmer text did not survive the round trip');

-- A forged normalised value would hide the row from duplicate detection.
insert into public.customers (business_id, full_name, phone, normalized_phone)
values (:'alpha_id'::uuid, 'Forged Phone', '012 999 888', '+999999999')
returning id as forged_id \gset
select pg_temp.assert(
  (select normalized_phone from public.customers where id = :'forged_id'::uuid) = '+85512999888',
  'a client-supplied normalized_phone was trusted');

-- created_by is an audit column, not a claim.
select pg_temp.assert_rejected(
  format($f$insert into public.customers (business_id, full_name, phone, created_by)
            values (%L, 'Impostor', '012111222', %L)$f$, :'alpha_id', :alice),
  'staff attributed a customer to somebody else');

-- Nothing that is not a phone number becomes a customer.
select pg_temp.assert_rejected(
  format($f$insert into public.customers (business_id, full_name, phone)
            values (%L, 'No Phone', 'call me')$f$, :'alpha_id'),
  'a customer without a usable phone number was accepted');

-- Staff correcting contact details is the everyday case.
update public.customers set full_name = 'សុខ ដារា', email = 'sok@alpha.test'
where id = :'sok_id'::uuid;
select pg_temp.assert(
  (select email from public.customers where id = :'sok_id'::uuid) = 'sok@alpha.test',
  'staff cannot update basic contact information');

-- Staff may write notes; that is the job.
insert into public.customer_notes (business_id, customer_id, body, created_by)
values (:'alpha_id'::uuid, :'sok_id'::uuid, 'Arrives late, pays cash.', :sam::uuid)
returning id as sam_note \gset
select pg_temp.assert(
  (select count(*) from public.customer_notes where customer_id = :'sok_id'::uuid) = 1,
  'staff cannot add a note');
reset role;

-- ===========================================================================
-- 3. Duplicate detection is per business, and only ever by phone
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;

-- Same number, spelled differently: still the same live customer.
select pg_temp.assert_rejected(
  format($f$insert into public.customers (business_id, full_name, phone)
            values (%L, 'Sok Dara Again', '+855 (0)12 345 678')$f$, :'alpha_id'),
  'the same phone was accepted twice in one business');

-- Same name, different number: two people, not a merge candidate.
insert into public.customers (business_id, full_name, phone)
values (:'alpha_id'::uuid, 'សុខ ដារា', '012 000 111')
returning id as namesake_id \gset
select pg_temp.assert(:'namesake_id'::uuid <> :'sok_id'::uuid,
  'a namesake was silently merged into the existing customer');
reset role;

-- The same guest may of course be known to both businesses.
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.customers (business_id, full_name, phone, created_by)
values (:'beta_id'::uuid, 'Sok Dara', '012345678', :bella::uuid)
returning id as beta_sok \gset
select pg_temp.assert(
  (select normalized_phone from public.customers where id = :'beta_sok'::uuid) = '+85512345678',
  'the shared number was not stored for Beta');
insert into public.customer_notes (business_id, customer_id, body, created_by)
values (:'beta_id'::uuid, :'beta_sok'::uuid, 'Beta private note.', :bella::uuid);
reset role;

-- ===========================================================================
-- 4. One business never sees, writes or moves another business's records
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.assert(
  (select count(*) from public.customers where business_id = :'alpha_id'::uuid) = 0,
  'Beta can read Alpha customers');
select pg_temp.assert(
  (select count(*) from public.customers) = 1,
  'Beta sees more than its own customers');
select pg_temp.assert(
  (select count(*) from public.customer_notes where business_id = :'alpha_id'::uuid) = 0,
  'Beta can read Alpha customer notes');
select pg_temp.assert(
  (select count(*) from public.customer_notes) = 1,
  'Beta sees more than its own notes');

-- A forged business_id is not a way in: membership is resolved from auth.uid().
select pg_temp.assert_rejected(
  format($f$insert into public.customers (business_id, full_name, phone)
            values (%L, 'Planted By Beta', '012777888')$f$, :'alpha_id'),
  'Beta created a customer inside Alpha');

-- Alpha rows are invisible, so this filters to zero rather than raising.
update public.customers set full_name = 'Renamed By Beta' where id = :'sok_id'::uuid;
update public.customer_notes set body = 'Rewritten by Beta' where id = :'sam_note'::uuid;

-- Notes inherit the customer's tenancy through the composite FK.
select pg_temp.assert_rejected(
  format($f$insert into public.customer_notes (business_id, customer_id, body)
            values (%L, %L, 'Note on a foreign customer')$f$, :'beta_id', :'sok_id'),
  'a note was attached to another business''s customer');
select pg_temp.assert_rejected(
  format($f$insert into public.customer_notes (business_id, customer_id, body)
            values (%L, %L, 'Note claiming Alpha')$f$, :'alpha_id', :'sok_id'),
  'Beta wrote a note into Alpha');

-- Moving one's own customer into another tenant is the same attack, reversed.
select pg_temp.assert_rejected(
  format('update public.customers set business_id = %L where id = %L',
         :'alpha_id', :'beta_sok'),
  'a customer was reassigned to an unauthorised business');
reset role;

select pg_temp.assert(
  (select full_name from public.customers where id = :'sok_id'::uuid) = 'សុខ ដារា',
  'a cross-tenant UPDATE changed the customer');
select pg_temp.assert(
  (select body from public.customer_notes where id = :'sam_note'::uuid) = 'Arrives late, pays cash.',
  'a cross-tenant UPDATE changed the note');

-- Alpha's owner is equally blind to Beta.
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  (select count(*) from public.customers where business_id = :'beta_id'::uuid) = 0,
  'Alpha owner can read Beta customers');
select pg_temp.assert(
  (select count(*) from public.customer_notes where business_id = :'beta_id'::uuid) = 0,
  'Alpha owner can read Beta notes');
reset role;

-- ===========================================================================
-- 5. Notes: staff write, owner and manager curate
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
-- USING filters instead of raising, so this is a silent no-op — assert the row.
update public.customer_notes set body = 'Edited by staff' where id = :'sam_note'::uuid;
select pg_temp.assert_rejected(
  format('delete from public.customer_notes where id = %L', :'sam_note'),
  'staff deleted a note');
select pg_temp.assert_rejected(
  format('delete from public.customers where id = %L', :'sok_id'),
  'staff deleted a customer');
reset role;

select pg_temp.assert(
  (select body from public.customer_notes where id = :'sam_note'::uuid) = 'Arrives late, pays cash.',
  'staff edited a note');

select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;
update public.customer_notes set body = 'Arrives late. Pays cash.' where id = :'sam_note'::uuid;
select pg_temp.assert(
  (select body from public.customer_notes where id = :'sam_note'::uuid) = 'Arrives late. Pays cash.',
  'manager cannot correct a note');
update public.customer_notes set archived_at = now() where id = :'sam_note'::uuid;
select pg_temp.assert(
  (select archived_at from public.customer_notes where id = :'sam_note'::uuid) is not null,
  'manager cannot archive a note');
update public.customer_notes set archived_at = null where id = :'sam_note'::uuid;
reset role;

-- ===========================================================================
-- 6. Archiving is an RPC, it needs customers.archive, and it stays tenanted
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_rejected(
  format('select public.set_customer_archived(%L)', :'namesake_id'),
  'staff archived a customer');
-- Nor through a plain UPDATE: the row is visible, so WITH CHECK raises.
select pg_temp.assert_rejected(
  format('update public.customers set archived_at = now() where id = %L', :'namesake_id'),
  'staff archived a customer through a plain UPDATE');
reset role;

select pg_temp.assert(
  (select archived_at from public.customers where id = :'namesake_id'::uuid) is null,
  'archived_at was set outside set_customer_archived()');

select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;
select public.set_customer_archived(:'namesake_id'::uuid);
select pg_temp.assert(
  (select archived_at from public.customers where id = :'namesake_id'::uuid) is not null,
  'manager cannot archive a customer');

-- Unlike properties, the archived row stays readable: the list has an archived
-- filter, restoring reads it first, and duplicate detection must still see it.
select pg_temp.assert(
  (select count(*) from public.customers where id = :'namesake_id'::uuid) = 1,
  'an archived customer disappeared from its own business');

-- ...but it is read-only until restored (USING filters, so this is a no-op).
update public.customers set full_name = 'Edited While Archived'
where id = :'namesake_id'::uuid;
select pg_temp.assert(
  (select full_name from public.customers where id = :'namesake_id'::uuid) = 'សុខ ដារា',
  'an archived customer was edited');

-- Archiving frees the number for a new live record; restoring must not clash.
insert into public.customers (business_id, full_name, phone)
values (:'alpha_id'::uuid, 'New Owner Of That Number', '012 000 111');
select pg_temp.assert_rejected(
  format('select public.set_customer_archived(%L, false)', :'namesake_id'),
  'restoring re-created a duplicate live phone number');

select public.set_customer_archived(:'sok_id'::uuid);
select public.set_customer_archived(:'sok_id'::uuid, false);
select pg_temp.assert(
  (select archived_at from public.customers where id = :'sok_id'::uuid) is null,
  'manager cannot restore a customer');
reset role;

-- An archived customer is still somebody else's data.
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  (select count(*) from public.customers where id = :'namesake_id'::uuid) = 0,
  'Beta can read an archived Alpha customer');
select pg_temp.assert_rejected(
  format('select public.set_customer_archived(%L, false)', :'namesake_id'),
  'Beta restored an Alpha customer');
reset role;

-- ===========================================================================
-- 7. Import: manager and owner only, never into a foreign business, and
--    every row reports its own outcome
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_rejected(
  format($f$select public.import_customers(%L, '[{"full_name":"X","phone":"012222333"}]'::jsonb)$f$,
         :'alpha_id'),
  'staff ran a bulk import');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.assert_rejected(
  format($f$select public.import_customers(%L, '[{"full_name":"X","phone":"012222333"}]'::jsonb)$f$,
         :'beta_id'),
  'Alpha imported customers into Beta');

select public.import_customers(:'alpha_id'::uuid, $j$[
  {"full_name": "ចាន់ សុភា", "phone": "012 555 666", "email": "sophea@alpha.test",
   "facebook_name": "Chan Sophea", "telegram_username": "sophea", "note": "Repeat guest"},
  {"full_name": "Sok Dara", "phone": "+85512345678"},
  {"full_name": "", "phone": "012 555 777"},
  {"full_name": "Bad Number", "phone": "nope"}
]$j$::jsonb) as import_result \gset

select pg_temp.assert(
  (select jsonb_agg(r->>'status' order by (r->>'index')::int)
   from jsonb_array_elements(:'import_result'::jsonb) r)
    = '["imported","duplicate","invalid","invalid"]'::jsonb,
  'import did not report one honest outcome per row');
select pg_temp.assert(
  (select count(*) from public.customers
   where business_id = :'alpha_id'::uuid and full_name = 'ចាន់ សុភា') = 1,
  'the valid Khmer row was not imported');
select pg_temp.assert(
  (select count(*) from public.customers where phone = '012 555 777') = 0,
  'an invalid row was imported anyway');
select pg_temp.assert(
  (select created_by from public.customers
   where business_id = :'alpha_id'::uuid and full_name = 'ចាន់ សុភា') = :mark::uuid,
  'the importer was not recorded as the creator');

-- The size bound is a real limit, not a UI convention.
select jsonb_agg(jsonb_build_object(
         'full_name', 'Bulk ' || g,
         'phone', '01' || lpad(g::text, 7, '0'))) as bulk_rows
from generate_series(1, 501) g \gset
select pg_temp.assert_rejected(
  format('select public.import_customers(%L, %L::jsonb)', :'alpha_id', :'bulk_rows'),
  'an oversized import was accepted');
reset role;

-- ===========================================================================
-- 8. Export: owners and managers only, scoped to the chosen business
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_rejected(
  format('select * from public.export_customers(%L)', :'alpha_id'),
  'staff bulk exported the customer list');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :stan, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_rejected(
  format('select * from public.export_customers(%L)', :'beta_id'),
  'Beta staff bulk exported the customer list');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.assert_rejected(
  format('select * from public.export_customers(%L)', :'beta_id'),
  'Alpha owner exported Beta customers');

select pg_temp.assert(
  (select bool_and(business_id = :'alpha_id'::uuid)
   from public.export_customers(:'alpha_id'::uuid, null)),
  'the export leaked rows from another business');
select pg_temp.assert(
  (select count(*) from public.export_customers(:'alpha_id'::uuid, true)) = 1,
  'the archived export did not return exactly the archived customer');
select pg_temp.assert(
  (select count(*) from public.export_customers(:'alpha_id'::uuid, false)
   where archived_at is not null) = 0,
  'the active export included archived customers');
-- Search covers the typed number, the normalised number and Khmer names.
select pg_temp.assert(
  (select count(*) from public.export_customers(:'alpha_id'::uuid, false, '012 345 678')) = 1,
  'search by the typed number found nothing');
select pg_temp.assert(
  (select count(*) from public.export_customers(:'alpha_id'::uuid, false, '+85512345678')) = 1,
  'search by the normalised number found nothing');
select pg_temp.assert(
  (select count(*) from public.export_customers(:'alpha_id'::uuid, false, 'ចាន់')) = 1,
  'search by a Khmer name found nothing');
select pg_temp.assert(
  (select count(*) from public.export_customers(:'alpha_id'::uuid, false, 'sophea')) = 1,
  'search by telegram username found nothing');
reset role;

-- ===========================================================================
-- 9. Anonymous callers see nothing and can call nothing
-- ===========================================================================
select set_config('request.jwt.claims', '', true);
set local role anon;
select pg_temp.assert_rejected(
  'select count(*) from public.customers', 'anon can read customers');
select pg_temp.assert_rejected(
  'select count(*) from public.customer_notes', 'anon can read customer notes');
select pg_temp.assert_rejected(
  format($f$insert into public.customers (business_id, full_name, phone)
            values (%L, 'Anon', '012333444')$f$, :'alpha_id'),
  'anon created a customer');
select pg_temp.assert_rejected(
  format('select public.set_customer_archived(%L)', :'sok_id'),
  'anon archived a customer');
select pg_temp.assert_rejected(
  format('select public.export_customers(%L)', :'alpha_id'),
  'anon exported the customer list');
select pg_temp.assert_rejected(
  format($f$select public.import_customers(%L, '[]'::jsonb)$f$, :'alpha_id'),
  'anon imported customers');
select pg_temp.assert_rejected(
  $f$select public.normalize_phone('012345678')$f$,
  'anon can call normalize_phone');
reset role;

select 'ALL CUSTOMER RLS TESTS PASSED' as result;

rollback;
