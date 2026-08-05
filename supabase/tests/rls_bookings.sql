-- =============================================================================
-- Phase 4 tenant isolation suite: bookings, statuses and conflict control.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_bookings.sql
--
-- Same shape as the Phase 1-3 suites: one rolled-back transaction, two
-- unrelated businesses, five users, and an assertion helper that cannot pass
-- silently. Both businesses hold bookings, so "I saw 0 rows" is never a false
-- pass — every cross-tenant read is asserted against data that demonstrably
-- exists on the other side.
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

-- Same as assert_rejected, but proves *why* it was rejected: a permission test
-- that passes because of a typo in a column name is not a permission test.
create or replace function pg_temp.assert_error(p_sql text, p_message_like text, p_message text)
returns void language plpgsql as $$
declare
  v_error text;
begin
  begin
    execute p_sql;
  exception
    when sqlstate 'ASRT1' then raise;
    when others then
      v_error := sqlerrm;
      if v_error not like p_message_like then
        raise exception 'ASSERTION FAILED: % (got "%", wanted "%")',
          p_message, v_error, p_message_like using errcode = 'ASRT1';
      end if;
      return;
  end;
  raise exception 'ASSERTION FAILED: % (statement succeeded)', p_message
    using errcode = 'ASRT1';
end;
$$;

grant execute on function pg_temp.assert(boolean, text) to public;
grant execute on function pg_temp.assert_rejected(text, text) to public;
grant execute on function pg_temp.assert_error(text, text, text) to public;

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
-- Weekday 40, weekend 60, in the business's own currency.
select id as alpha_prop from public.create_property(
  :'alpha_id'::uuid, 'Alpha Riverside Villa', 40, 60) \gset
insert into public.customers (business_id, full_name, phone, created_by)
values (:'alpha_id'::uuid, 'សុខ ដារា', '012 345 678', :alice::uuid)
returning id as alpha_cust \gset
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as beta_id from public.create_business(
  'Beta Villas', 'Bella Owner', '+85512000002', 'en', 'USD', 'Asia/Bangkok') \gset
select id as beta_prop from public.create_property(
  :'beta_id'::uuid, 'Beta Beach House', 100, 150) \gset
insert into public.customers (business_id, full_name, phone, created_by)
values (:'beta_id'::uuid, 'Beta Guest', '077 111 222', :bella::uuid)
returning id as beta_cust \gset
reset role;

insert into public.business_members (business_id, user_id, role, status) values
  (:'alpha_id'::uuid, :mark::uuid, 'manager', 'active'),
  (:'alpha_id'::uuid, :sam::uuid,  'staff',   'active'),
  (:'beta_id'::uuid,  :stan::uuid, 'staff',   'active');

select id as alpha_pending from public.booking_statuses
  where business_id = :'alpha_id'::uuid and code = 'pending' and is_system \gset
select id as alpha_confirmed from public.booking_statuses
  where business_id = :'alpha_id'::uuid and code = 'confirmed' and is_system \gset
select id as alpha_cancelled from public.booking_statuses
  where business_id = :'alpha_id'::uuid and code = 'cancelled' and is_system \gset
select id as beta_pending from public.booking_statuses
  where business_id = :'beta_id'::uuid and code = 'pending' and is_system \gset

-- ===========================================================================
-- 1. Creating a business seeds exactly the four system statuses
-- ===========================================================================
select pg_temp.assert(
  (select count(*) from public.booking_statuses where business_id = :'alpha_id'::uuid) = 4,
  'a new business did not get the four default statuses');
select pg_temp.assert(
  (select array_agg(code::text order by sort_order) from public.booking_statuses
   where business_id = :'alpha_id'::uuid)
    = array['pending', 'confirmed', 'completed', 'cancelled'],
  'the default statuses are wrong or out of order');
select pg_temp.assert(
  (select bool_and(is_system and is_active) from public.booking_statuses
   where business_id = :'alpha_id'::uuid),
  'default statuses were not seeded as active system rows');
-- Each business gets its own copy; BETA cannot end up sharing ALPHA's list.
select pg_temp.assert(
  (select count(*) from public.booking_statuses where business_id = :'beta_id'::uuid) = 4,
  'BETA did not get its own status list');

-- ===========================================================================
-- 2. Staff may take a booking. The price and the number come from the server.
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;

-- Mon 7 Sep to Thu 10 Sep 2026: three weekday nights at 40.
select id as bk1 from public.save_booking(
  p_business_id => :'alpha_id'::uuid,
  p_property_id => :'alpha_prop'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-09-07 14:00+07'::timestamptz,
  p_check_out   => '2026-09-10 12:00+07'::timestamptz,
  p_source      => 'facebook',
  p_note        => 'Messenger enquiry') \gset

select pg_temp.assert(
  (select calculated_price from public.bookings where id = :'bk1'::uuid) = 120,
  'three weekday nights were not priced at 3 x 40');
select pg_temp.assert(
  (select final_price from public.bookings where id = :'bk1'::uuid) = 120
  and (select not price_overridden from public.bookings where id = :'bk1'::uuid),
  'an untouched price was recorded as an override');
select pg_temp.assert(
  (select currency from public.bookings where id = :'bk1'::uuid) = 'KHR',
  'the booking did not take the property currency');
select pg_temp.assert(
  (select booking_number from public.bookings where id = :'bk1'::uuid) = 'BK-2026-000001',
  'the first booking of the year was not numbered BK-2026-000001');
select pg_temp.assert(
  (select created_by from public.bookings where id = :'bk1'::uuid) = :sam::uuid,
  'created_by was not stamped with the caller');

-- Pending holds the dates for 30 minutes, and says so on the row.
select pg_temp.assert(
  (select pending_expires_at from public.bookings where id = :'bk1'::uuid)
    between now() + interval '29 minutes' and now() + interval '31 minutes',
  'the pending hold was not set to 30 minutes');
select pg_temp.assert(
  (select pending_resolved_at is null from public.bookings where id = :'bk1'::uuid),
  'a fresh pending booking was already marked as resolved');

-- The status change was recorded without anyone being granted INSERT on it.
select pg_temp.assert(
  (select count(*) from public.booking_status_history where booking_id = :'bk1'::uuid) = 1,
  'the opening status was not written to booking_status_history');

-- ===========================================================================
-- 3. Availability: adjacent is fine, overlapping is not
-- ===========================================================================
-- Checking in at 12:00 on the 10th, the minute the previous guest leaves.
select id as bk2 from public.save_booking(
  p_business_id => :'alpha_id'::uuid,
  p_property_id => :'alpha_prop'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-09-10 12:00+07'::timestamptz,
  p_check_out   => '2026-09-12 12:00+07'::timestamptz) \gset

select pg_temp.assert(
  (select booking_number from public.bookings where id = :'bk2'::uuid) = 'BK-2026-000002',
  'the booking number did not advance');
-- Thu 10 (40) + Fri 11 (60): the weekend rate starts on Friday.
select pg_temp.assert(
  (select calculated_price from public.bookings where id = :'bk2'::uuid) = 100,
  'a Thursday-Friday stay was not priced 40 + 60');

select pg_temp.assert(
  jsonb_array_length(public.check_booking_availability(
    :'alpha_id'::uuid, :'alpha_prop'::uuid,
    '2026-09-10 12:00+07'::timestamptz, '2026-09-10 18:00+07'::timestamptz, :'bk2'::uuid)) = 0,
  'a back-to-back slot was reported as taken');

select pg_temp.assert(
  jsonb_array_length(public.check_booking_availability(
    :'alpha_id'::uuid, :'alpha_prop'::uuid,
    '2026-09-08 14:00+07'::timestamptz, '2026-09-09 12:00+07'::timestamptz)) = 1,
  'an overlapping range was not reported as a conflict');

-- An overlap is refused by default, whoever is asking.
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2026-09-08 14:00+07'::timestamptz, '2026-09-09 12:00+07'::timestamptz)$f$,
         :'alpha_id', :'alpha_prop', :'alpha_cust'),
  'booking_conflict', 'an overlapping booking was accepted');

-- Staff cannot buy their way past it.
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2026-09-08 14:00+07'::timestamptz, '2026-09-09 12:00+07'::timestamptz,
            p_conflict_override => true, p_conflict_reason => 'guest insisted')$f$,
         :'alpha_id', :'alpha_prop', :'alpha_cust'),
  'forbidden', 'staff overrode a booking conflict');

-- Nor past the price.
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2026-10-05 14:00+07'::timestamptz, '2026-10-06 12:00+07'::timestamptz,
            p_final_price => 1, p_price_reason => 'friend of mine')$f$,
         :'alpha_id', :'alpha_prop', :'alpha_cust'),
  'forbidden', 'staff overrode the price');

-- A manual block from Phase 2 blocks a booking just as an existing stay does.
select pg_temp.assert_rejected(
  format($f$insert into public.property_blocks
            (business_id, property_id, starts_at, ends_at, reason)
            values (%L, %L, '2026-11-01 00:00+07', '2026-11-05 00:00+07', 'maintenance')$f$,
         :'beta_id', :'beta_prop'),
  'ALPHA staff created a block on a BETA property');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.property_blocks (business_id, property_id, starts_at, ends_at, reason, created_by)
values (:'alpha_id'::uuid, :'alpha_prop'::uuid,
        '2026-11-01 00:00+07', '2026-11-05 00:00+07', 'maintenance', :alice::uuid);
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2026-11-02 14:00+07'::timestamptz, '2026-11-03 12:00+07'::timestamptz)$f$,
         :'alpha_id', :'alpha_prop', :'alpha_cust'),
  'booking_conflict', 'a booking was accepted over a maintenance block');
reset role;

-- ===========================================================================
-- 4. Manager may override a conflict, with a reason, and it is recorded
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;

-- A reason is not optional, even for someone allowed to override.
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2026-09-08 14:00+07'::timestamptz, '2026-09-09 12:00+07'::timestamptz,
            p_conflict_override => true)$f$,
         :'alpha_id', :'alpha_prop', :'alpha_cust'),
  'conflict_reason_required', 'a conflict was overridden without a reason');

select id as bk3 from public.save_booking(
  p_business_id       => :'alpha_id'::uuid,
  p_property_id       => :'alpha_prop'::uuid,
  p_customer_id       => :'alpha_cust'::uuid,
  p_check_in          => '2026-09-08 14:00+07'::timestamptz,
  p_check_out         => '2026-09-09 12:00+07'::timestamptz,
  p_conflict_override => true,
  p_conflict_reason   => 'Owner approved the double booking by phone') \gset

select pg_temp.assert(
  (select conflict_override and conflict_override_by = :mark::uuid
          and conflict_override_at is not null
     from public.bookings where id = :'bk3'::uuid),
  'the override was not attributed to the approver');

-- Price override: reason required, calculated total preserved beside it.
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2026-10-05 14:00+07'::timestamptz, '2026-10-07 12:00+07'::timestamptz,
            p_final_price => 50)$f$,
         :'alpha_id', :'alpha_prop', :'alpha_cust'),
  'price_reason_required', 'a price was overridden without a reason');

select id as bk4 from public.save_booking(
  p_business_id  => :'alpha_id'::uuid,
  p_property_id  => :'alpha_prop'::uuid,
  p_customer_id  => :'alpha_cust'::uuid,
  p_check_in     => '2026-10-05 14:00+07'::timestamptz,
  p_check_out    => '2026-10-07 12:00+07'::timestamptz,
  p_final_price  => 50,
  p_price_reason => 'Returning guest discount') \gset

select pg_temp.assert(
  (select calculated_price = 80 and final_price = 50 and price_overridden
     from public.bookings where id = :'bk4'::uuid),
  'the original quote was not kept alongside the override');

-- Later price changes must never rewrite history.
reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
update public.property_pricing set weekday_price = 999, weekend_price = 999
where property_id = :'alpha_prop'::uuid;
reset role;

select pg_temp.assert(
  (select calculated_price from public.bookings where id = :'bk1'::uuid) = 120,
  'raising the room rate rewrote a historical booking total');

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
update public.property_pricing set weekday_price = 40, weekend_price = 60
where property_id = :'alpha_prop'::uuid;
reset role;

-- ===========================================================================
-- 5. The dangerous columns are unreachable without the RPC
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.assert_rejected(
  format($f$insert into public.bookings
            (business_id, booking_number, property_id, customer_id, status_id,
             check_in_at, check_out_at, currency, calculated_price, final_price)
            values (%L, 'BK-2026-999999', %L, %L, %L,
                    '2026-09-08 14:00+07', '2026-09-09 12:00+07', 'KHR', 0, 0)$f$,
         :'alpha_id', :'alpha_prop', :'alpha_cust', :'alpha_pending'),
  'a booking was inserted straight into the table, skipping the conflict check');

select pg_temp.assert_rejected(
  format($f$update public.bookings set check_in_at = '2026-12-01 14:00+07' where id = %L$f$,
         :'bk1'),
  'dates were moved without the conflict check');
select pg_temp.assert_rejected(
  format('update public.bookings set final_price = 1 where id = %L', :'bk1'),
  'the price was edited straight on the table');
select pg_temp.assert_rejected(
  format('update public.bookings set status_id = %L where id = %L', :'alpha_cancelled', :'bk1'),
  'the status was changed straight on the table');
select pg_temp.assert_rejected(
  format('update public.bookings set conflict_override = true where id = %L', :'bk1'),
  'the override flag was set straight on the table');
select pg_temp.assert_rejected(
  format('delete from public.bookings where id = %L', :'bk1'),
  'a booking was deleted');
select pg_temp.assert_rejected(
  'select count(*) from public.booking_counters',
  'the booking number counter is readable by clients');

-- Notes are the one thing staff may write directly — that is the whole point.
update public.bookings set note = 'Arriving late', internal_note = 'Cash on arrival'
where id = :'bk1'::uuid;
select pg_temp.assert(
  (select note from public.bookings where id = :'bk1'::uuid) = 'Arriving late',
  'staff could not add a booking note');

-- Nor may staff touch the status list.
select pg_temp.assert_rejected(
  format($f$insert into public.booking_statuses (business_id, name, code, color, sort_order)
            values (%L, 'Deposit paid', 'confirmed', '#123456', 5)$f$, :'alpha_id'),
  'staff added a booking status');
-- The UPDATE policy filters rather than errors, so the proof is that nothing
-- moved: a policy that matches no row updates no row.
update public.booking_statuses set name = 'Maybe' where id = :'alpha_pending'::uuid;
reset role;
select pg_temp.assert(
  (select name from public.booking_statuses where id = :'alpha_pending'::uuid) <> 'Maybe',
  'staff renamed a booking status');

-- ===========================================================================
-- 6. Status customisation is the owner's, and the system codes are protected
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_rejected(
  format($f$insert into public.booking_statuses (business_id, name, code, color, sort_order)
            values (%L, 'Deposit paid', 'confirmed', '#123456', 5)$f$, :'alpha_id'),
  'a manager added a booking status');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;

insert into public.booking_statuses (business_id, name, code, color, sort_order)
values (:'alpha_id'::uuid, 'Deposit paid', 'confirmed', '#1d4ed8', 5)
returning id as alpha_deposit \gset

-- Renaming and reordering a built-in is allowed; changing what it means is not.
update public.booking_statuses set name = 'Awaiting deposit', sort_order = 0
where id = :'alpha_pending'::uuid;
select pg_temp.assert(
  (select name from public.booking_statuses where id = :'alpha_pending'::uuid)
    = 'Awaiting deposit',
  'the owner could not rename a system status');
select pg_temp.assert_rejected(
  format('update public.booking_statuses set code = %L where id = %L',
         'cancelled', :'alpha_pending'),
  'the internal code of a system status was changed');
select pg_temp.assert_rejected(
  format('update public.booking_statuses set is_system = false where id = %L', :'alpha_pending'),
  'a system status was demoted to a custom one');
select pg_temp.assert_rejected(
  format('delete from public.booking_statuses where id = %L', :'alpha_pending'),
  'a system status was deleted');
-- A client cannot mint a second "system" status either.
select pg_temp.assert_rejected(
  format($f$insert into public.booking_statuses
            (business_id, name, code, color, sort_order, is_system)
            values (%L, 'Fake system', 'pending', '#000000', 9, true)$f$, :'alpha_id'),
  'a client inserted a system status');
reset role;

-- ===========================================================================
-- 7. Cancel, restore and the pending review
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format('select public.set_booking_status(%L, %L)', :'bk2', :'alpha_cancelled'),
  'forbidden', 'staff cancelled a booking');
select pg_temp.assert_error(
  format($f$select public.resolve_pending_booking(%L, 'release')$f$, :'bk1'),
  'forbidden', 'staff resolved an expired hold');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;

select public.set_booking_status(:'bk2'::uuid, :'alpha_cancelled'::uuid);
select pg_temp.assert(
  (select cancelled_at is not null and pending_expires_at is null
     from public.bookings where id = :'bk2'::uuid),
  'cancelling did not stamp cancelled_at and clear the hold');
select pg_temp.assert(
  (select count(*) from public.booking_status_history where booking_id = :'bk2'::uuid) = 2,
  'the cancellation was not recorded in the status history');

-- A cancelled booking hands its dates back.
select pg_temp.assert(
  jsonb_array_length(public.check_booking_availability(
    :'alpha_id'::uuid, :'alpha_prop'::uuid,
    '2026-09-11 14:00+07'::timestamptz, '2026-09-12 12:00+07'::timestamptz)) = 0,
  'a cancelled booking still blocked its dates');

-- ...and someone else takes them.
select id as bk5 from public.save_booking(
  p_business_id => :'alpha_id'::uuid,
  p_property_id => :'alpha_prop'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-09-11 14:00+07'::timestamptz,
  p_check_out   => '2026-09-12 12:00+07'::timestamptz) \gset

-- Reopening is the owner's call, not the manager's.
select pg_temp.assert_error(
  format('select public.set_booking_status(%L, %L)', :'bk2', :'alpha_confirmed'),
  'forbidden', 'a manager restored a cancelled booking');

-- Pending review: keeping the hold stops the nagging without freeing the dates.
select public.resolve_pending_booking(:'bk1'::uuid, 'keep');
select pg_temp.assert(
  (select pending_resolved_at is not null from public.bookings where id = :'bk1'::uuid),
  'keeping a pending booking did not stamp pending_resolved_at');
select pg_temp.assert(
  jsonb_array_length(public.check_booking_availability(
    :'alpha_id'::uuid, :'alpha_prop'::uuid,
    '2026-09-08 14:00+07'::timestamptz, '2026-09-09 12:00+07'::timestamptz, :'bk3'::uuid)) > 0,
  'a kept pending booking stopped holding its dates');

-- Releasing is what frees them, and it goes through cancellation.
select public.resolve_pending_booking(:'bk4'::uuid, 'release');
select pg_temp.assert(
  (select code from public.booking_statuses s
   join public.bookings b on b.status_id = s.id where b.id = :'bk4'::uuid) = 'cancelled',
  'releasing a pending booking did not cancel it');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
-- Restoring re-checks availability: bk3 was overridden onto the same dates.
select pg_temp.assert_error(
  format('select public.set_booking_status(%L, %L)', :'bk2', :'alpha_confirmed'),
  'booking_conflict', 'a booking was restored onto dates that had been given away');
reset role;

-- ===========================================================================
-- 8. Tenant isolation: two businesses, neither can see or touch the other
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :stan, 'role', 'authenticated')::text, true);
set local role authenticated;

-- BETA has bookings of its own, so an empty ALPHA read is a real result.
select id as beta_bk from public.save_booking(
  p_business_id => :'beta_id'::uuid,
  p_property_id => :'beta_prop'::uuid,
  p_customer_id => :'beta_cust'::uuid,
  p_check_in    => '2026-09-07 14:00+07'::timestamptz,
  p_check_out   => '2026-09-08 12:00+07'::timestamptz) \gset

select pg_temp.assert(
  (select count(*) from public.bookings) = 1,
  'BETA staff can see ALPHA bookings');
select pg_temp.assert(
  (select count(*) from public.bookings where business_id = :'alpha_id'::uuid) = 0,
  'BETA staff read ALPHA bookings by naming the business');
select pg_temp.assert(
  (select count(*) from public.booking_statuses where business_id = :'alpha_id'::uuid) = 0,
  'BETA staff can see ALPHA statuses');
select pg_temp.assert(
  (select count(*) from public.booking_status_history
   where business_id = :'alpha_id'::uuid) = 0,
  'BETA staff can see ALPHA status history');

-- Numbering is per business: BETA's first booking is also 000001, and that
-- tells BETA nothing about how much ALPHA has sold.
select pg_temp.assert(
  (select booking_number from public.bookings where id = :'beta_bk'::uuid) = 'BK-2026-000001',
  'booking numbers are not scoped per business');

-- Naming ALPHA's id buys nothing: membership is resolved from the token.
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2027-01-05 14:00+07'::timestamptz, '2027-01-06 12:00+07'::timestamptz)$f$,
         :'alpha_id', :'alpha_prop', :'alpha_cust'),
  'forbidden', 'BETA staff created a booking in ALPHA');
select pg_temp.assert_error(
  format('select public.set_booking_status(%L, %L)', :'bk1', :'alpha_cancelled'),
  'forbidden', 'BETA staff changed the status of an ALPHA booking');
select pg_temp.assert_error(
  format($f$select public.resolve_pending_booking(%L, 'release')$f$, :'bk1'),
  'forbidden', 'BETA staff resolved an ALPHA hold');
select pg_temp.assert_error(
  format($f$select public.check_booking_availability(%L, %L,
            '2027-01-05 14:00+07'::timestamptz, '2027-01-06 12:00+07'::timestamptz)$f$,
         :'alpha_id', :'alpha_prop'),
  'forbidden', 'BETA staff read ALPHA availability');
-- These are filtered by the policy rather than refused outright, so what
-- matters is that no ALPHA row moved.
update public.bookings set note = 'hijacked' where id = :'bk1'::uuid;
update public.booking_statuses set name = 'Hijacked' where id = :'alpha_pending'::uuid;

reset role;
select pg_temp.assert(
  (select count(*) from public.bookings where note = 'hijacked') = 0,
  'a cross-tenant note write got through');
select pg_temp.assert(
  (select count(*) from public.booking_statuses where name = 'Hijacked') = 0,
  'a cross-tenant status rename got through');

-- Mixing tenants inside one booking is refused even by BETA's own owner.
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2027-02-05 14:00+07'::timestamptz, '2027-02-06 12:00+07'::timestamptz)$f$,
         :'beta_id', :'beta_prop', :'alpha_cust'),
  'customer_not_found', 'a BETA booking was linked to an ALPHA customer');
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2027-02-05 14:00+07'::timestamptz, '2027-02-06 12:00+07'::timestamptz)$f$,
         :'beta_id', :'alpha_prop', :'beta_cust'),
  'property_not_found', 'a BETA booking was placed on an ALPHA property');
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2027-02-05 14:00+07'::timestamptz, '2027-02-06 12:00+07'::timestamptz,
            p_status_id => %L)$f$,
         :'beta_id', :'beta_prop', :'beta_cust', :'alpha_pending'),
  'status_not_found', 'a BETA booking was given an ALPHA status');
reset role;

-- ===========================================================================
-- 9. Basic validation that must not depend on the client
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2026-12-05 14:00+07'::timestamptz, '2026-12-05 14:00+07'::timestamptz)$f$,
         :'alpha_id', :'alpha_prop', :'alpha_cust'),
  'invalid_range', 'a booking that ends when it starts was accepted');
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2026-12-05 14:00+07'::timestamptz, '2026-12-04 12:00+07'::timestamptz)$f$,
         :'alpha_id', :'alpha_prop', :'alpha_cust'),
  'invalid_range', 'a backwards booking was accepted');
select pg_temp.assert_error(
  format($f$select public.resolve_pending_booking(%L, 'delete')$f$, :'bk1'),
  'invalid_action', 'an unknown pending action was accepted');
reset role;

-- An archived property cannot take new bookings.
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as alpha_prop2 from public.create_property(
  :'alpha_id'::uuid, 'Alpha Garden Cottage', 30, 45) \gset
select public.set_property_archived(:'alpha_prop2'::uuid, true);
select pg_temp.assert_error(
  format($f$select public.save_booking(%L, %L, %L,
            '2026-12-05 14:00+07'::timestamptz, '2026-12-06 12:00+07'::timestamptz)$f$,
         :'alpha_id', :'alpha_prop2', :'alpha_cust'),
  'property_unavailable', 'an archived property took a booking');
reset role;

-- ===========================================================================
-- 10. Anonymous callers see nothing and can call nothing
-- ===========================================================================
select set_config('request.jwt.claims', '', true);
set local role anon;
select pg_temp.assert_rejected(
  'select count(*) from public.bookings', 'anon can read bookings');
select pg_temp.assert_rejected(
  'select count(*) from public.booking_statuses', 'anon can read booking statuses');
select pg_temp.assert_rejected(
  'select count(*) from public.booking_status_history', 'anon can read status history');
select pg_temp.assert_rejected(
  format($f$select public.save_booking(%L, %L, %L,
            '2027-03-05 14:00+07'::timestamptz, '2027-03-06 12:00+07'::timestamptz)$f$,
         :'alpha_id', :'alpha_prop', :'alpha_cust'),
  'anon created a booking');
select pg_temp.assert_rejected(
  format('select public.set_booking_status(%L, %L)', :'bk1', :'alpha_cancelled'),
  'anon changed a booking status');
select pg_temp.assert_rejected(
  format($f$select public.resolve_pending_booking(%L, 'keep')$f$, :'bk1'),
  'anon resolved a pending booking');
select pg_temp.assert_rejected(
  format($f$select public.check_booking_availability(%L, %L,
            '2027-03-05 14:00+07'::timestamptz, '2027-03-06 12:00+07'::timestamptz)$f$,
         :'alpha_id', :'alpha_prop'),
  'anon read availability');
select pg_temp.assert_rejected(
  format($f$select public.booking_conflicts(%L, %L,
            '2027-03-05 14:00+07'::timestamptz, '2027-03-06 12:00+07'::timestamptz)$f$,
         :'alpha_id', :'alpha_prop'),
  'anon called the internal conflict scan');
select pg_temp.assert_rejected(
  format($f$select public.booking_calculated_price(%L,
            '2027-03-05 14:00+07'::timestamptz, '2027-03-06 12:00+07'::timestamptz,
            'Asia/Phnom_Penh')$f$, :'alpha_prop'),
  'anon priced a property');
select pg_temp.assert_rejected(
  format($f$select public.next_booking_number(%L, now(), 'Asia/Phnom_Penh')$f$, :'alpha_id'),
  'anon burned a booking number');
reset role;

select 'ALL BOOKING RLS TESTS PASSED' as result;

rollback;
