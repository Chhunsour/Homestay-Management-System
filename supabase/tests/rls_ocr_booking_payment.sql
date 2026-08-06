-- =============================================================================
-- Phase 6C suite: record_ocr_payment() — connecting a reviewed OCR result to a
-- booking and a payment.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_ocr_booking_payment.sql
--
-- Same shape as the Phase 1-5 suites: one rolled-back transaction, two
-- unrelated businesses, an assertion helper that cannot pass silently, and
-- assert_error's implicit savepoint so an expected failure never aborts the
-- rest of the file. One property per scenario that could conflict with
-- another, so nothing here depends on ordering.
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
grant execute on function pg_temp.assert_error(text, text, text) to public;

-- ---------------------------------------------------------------------------
-- Fixtures — ALPHA: alice (owner), mark (manager), sam (staff). BETA: bella
-- (owner), stan (staff). One property per scenario avoids any date overlap
-- between tests standing in for each other's conflicts.
-- ---------------------------------------------------------------------------
\set alice '\'cccccccc-0000-4000-8000-000000000001\''
\set mark  '\'cccccccc-0000-4000-8000-000000000002\''
\set sam   '\'cccccccc-0000-4000-8000-000000000003\''
\set bella '\'dddddddd-0000-4000-8000-000000000001\''
\set stan  '\'dddddddd-0000-4000-8000-000000000002\''

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
values
  (:alice::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'alice@ocr-alpha.test', 'x', now(), now(), now(), '{}'::jsonb, '{"full_name":"Alice Owner"}'::jsonb),
  (:mark::uuid,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'mark@ocr-alpha.test', 'x', now(), now(), now(), '{}'::jsonb, '{"full_name":"Mark Manager"}'::jsonb),
  (:sam::uuid,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'sam@ocr-alpha.test', 'x', now(), now(), now(), '{}'::jsonb, '{"full_name":"Sam Staff"}'::jsonb),
  (:bella::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'bella@ocr-beta.test', 'x', now(), now(), now(), '{}'::jsonb, '{"full_name":"Bella Owner"}'::jsonb),
  (:stan::uuid,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'stan@ocr-beta.test', 'x', now(), now(), now(), '{}'::jsonb, '{"full_name":"Stan Staff"}'::jsonb);

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as alpha_id from public.create_business(
  'OCR Alpha Homestay', 'Alice Owner', '+85512900001', 'en', 'USD', 'Asia/Phnom_Penh') \gset
insert into public.customers (business_id, full_name, phone, created_by)
values (:'alpha_id'::uuid, 'Sok Dara', '012 900 001', :alice::uuid)
returning id as alpha_cust \gset
insert into public.customers (business_id, full_name, phone, created_by)
values (:'alpha_id'::uuid, 'Chan Sopheak', '012 900 002', :alice::uuid)
returning id as alpha_cust2 \gset
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as beta_id from public.create_business(
  'OCR Beta Villas', 'Bella Owner', '+85512900002', 'en', 'USD', 'Asia/Bangkok') \gset
select id as beta_prop from public.create_property(
  :'beta_id'::uuid, 'Beta Beach House', 100, 150) \gset
insert into public.customers (business_id, full_name, phone, created_by)
values (:'beta_id'::uuid, 'Beta Guest', '077 900 001', :bella::uuid)
returning id as beta_cust \gset
select id as beta_bk from public.save_booking(
  p_business_id => :'beta_id'::uuid, p_property_id => :'beta_prop'::uuid,
  p_customer_id => :'beta_cust'::uuid,
  p_check_in => '2026-09-01 14:00+07'::timestamptz,
  p_check_out => '2026-09-03 12:00+07'::timestamptz) \gset
reset role;

insert into public.business_members (business_id, user_id, role, status) values
  (:'alpha_id'::uuid, :mark::uuid, 'manager', 'active'),
  (:'alpha_id'::uuid, :sam::uuid,  'staff',   'active'),
  (:'beta_id'::uuid,  :stan::uuid, 'staff',   'active');

-- Properties, one per scenario. Weekday 40, weekend 60 throughout.
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as prop_existing  from public.create_property(:'alpha_id'::uuid, 'P Existing',  40, 60) \gset
select id as prop_exact     from public.create_property(:'alpha_id'::uuid, 'P Exact50',   40, 60) \gset
select id as prop_partial   from public.create_property(:'alpha_id'::uuid, 'P Partial',   40, 60) \gset
select id as prop_advance   from public.create_property(:'alpha_id'::uuid, 'P Advance',   40, 60) \gset
select id as prop_full      from public.create_property(:'alpha_id'::uuid, 'P Full',      40, 60) \gset
select id as prop_overpay   from public.create_property(:'alpha_id'::uuid, 'P Overpay',   40, 60) \gset
select id as prop_block     from public.create_property(:'alpha_id'::uuid, 'P Block',     40, 60) \gset
select id as prop_conflict  from public.create_property(:'alpha_id'::uuid, 'P Conflict',  40, 60) \gset
select id as prop_dup_ref   from public.create_property(:'alpha_id'::uuid, 'P DupRef',    40, 60) \gset
select id as prop_dup_proof from public.create_property(:'alpha_id'::uuid, 'P DupProof',  40, 60) \gset
select id as prop_manual    from public.create_property(:'alpha_id'::uuid, 'P Manual',    40, 60) \gset

-- The existing-booking scenario needs a booking already on the books before
-- the OCR flow ever runs.
select id as bk_existing from public.save_booking(
  p_business_id => :'alpha_id'::uuid, p_property_id => :'prop_existing'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-11-02 14:00+07'::timestamptz,
  p_check_out   => '2026-11-04 12:00+07'::timestamptz) \gset
reset role;

-- ===========================================================================
-- 1. OCR payment linked to an existing booking
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;

select result->>'booking_id' as r1_booking, result->>'payment_id' as r1_payment
from (select public.record_ocr_payment(
  p_business_id => :'alpha_id'::uuid,
  p_amount      => 30,
  p_method      => 'aba',
  p_booking_id  => :'bk_existing'::uuid,
  p_payment_type => 'deposit',
  p_reference   => 'ABA-EXIST-1',
  p_payer_name  => 'Sok Dara',
  p_provider    => 'claude-opus-5',
  p_extraction  => '{"amount":{"value":29,"confidence":0.8}}'::jsonb,
  p_original_values  => '{"amount":"29","payerName":"Sok D."}'::jsonb,
  p_corrected_values => '{"amount":"30","payerName":"Sok Dara"}'::jsonb,
  p_edited_fields    => array['amount','payerName']::text[]
) as result) s \gset

select pg_temp.assert(
  :'r1_booking' = :'bk_existing', 'the payment did not attach to the chosen existing booking');
select pg_temp.assert(
  (select count(*) from public.bookings where property_id = :'prop_existing'::uuid) = 1,
  'attaching to an existing booking created a second one');
select pg_temp.assert(
  (select amount from public.payments where id = :'r1_payment'::uuid) = 30,
  'the recorded amount did not match the reviewed amount');
select pg_temp.assert(
  (select manual_entry from public.payment_ocr_reviews where payment_id = :'r1_payment'::uuid) = false,
  'an OCR-backed payment was marked manual_entry');
select pg_temp.assert(
  (select edited_fields from public.payment_ocr_reviews where payment_id = :'r1_payment'::uuid)
    = array['amount','payerName'],
  'the audit row did not keep which fields the reviewer changed');
select pg_temp.assert(
  (select provider from public.payment_ocr_reviews where payment_id = :'r1_payment'::uuid) = 'claude-opus-5',
  'the audit row lost the OCR provider name');

-- ===========================================================================
-- 2. New booking and payment created together, exactly the 50% deposit
--    3 weekend nights (Fri, Sat, Sun) at 60 = 180; 90 is exactly half.
-- ===========================================================================
select result->>'booking_id' as r2_booking from (select public.record_ocr_payment(
  p_business_id => :'alpha_id'::uuid,
  p_amount      => 90,
  p_method      => 'khqr',
  p_property_id => :'prop_exact'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-11-06 14:00+07'::timestamptz,
  p_check_out   => '2026-11-09 12:00+07'::timestamptz,
  p_payment_type => 'deposit',
  p_manual_entry => true
) as result) s \gset

select pg_temp.assert(
  (select calculated_price from public.bookings where id = :'r2_booking'::uuid) = 180,
  'three weekend nights at 60 did not price to 180');
select pg_temp.assert(
  (select payment_status from public.booking_payment_summary(:'r2_booking'::uuid)) = 'deposit_paid',
  'exactly half was not reported as the deposit met');
select pg_temp.assert(
  (select s.code from public.bookings b join public.booking_statuses s on s.id = b.status_id
   where b.id = :'r2_booking'::uuid) = 'confirmed',
  'a new booking was not confirmed once its deposit arrived in the same call');

-- ===========================================================================
-- 3. Partial payment below 50%
--    2 weekday nights (Mon, Tue) at 40 = 80; 30 is below the 40 deposit line.
-- ===========================================================================
select result->>'booking_id' as r3_booking from (select public.record_ocr_payment(
  p_business_id => :'alpha_id'::uuid,
  p_amount      => 30,
  p_method      => 'cash',
  p_property_id => :'prop_partial'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-11-16 14:00+07'::timestamptz,
  p_check_out   => '2026-11-18 12:00+07'::timestamptz,
  p_manual_entry => true
) as result) s \gset

select pg_temp.assert(
  (select calculated_price from public.bookings where id = :'r3_booking'::uuid) = 80,
  'two weekday nights at 40 did not price to 80');
select pg_temp.assert(
  (select payment_status from public.booking_payment_summary(:'r3_booking'::uuid)) = 'partial',
  '30 of 80 was not reported as partial');
select pg_temp.assert(
  (select s.code from public.bookings b join public.booking_statuses s on s.id = b.status_id
   where b.id = :'r3_booking'::uuid) = 'pending',
  'a booking below its deposit line was confirmed anyway');

-- ===========================================================================
-- 4. Advance payment: more than 50%, less than the total
--    3 weekday nights at 40 = 120; 90 is 75%, past the 60 deposit line.
-- ===========================================================================
select result->>'booking_id' as r4_booking from (select public.record_ocr_payment(
  p_business_id => :'alpha_id'::uuid,
  p_amount      => 90,
  p_method      => 'bank_transfer',
  p_property_id => :'prop_advance'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-11-23 14:00+07'::timestamptz,
  p_check_out   => '2026-11-26 12:00+07'::timestamptz,
  p_manual_entry => true
) as result) s \gset

select pg_temp.assert(
  (select payment_status from public.booking_payment_summary(:'r4_booking'::uuid)) = 'deposit_paid',
  'an advance past the deposit line was not reported as deposit met');
select pg_temp.assert(
  (select balance from public.booking_payment_summary(:'r4_booking'::uuid)) = 30,
  'the remaining balance after a 90-of-120 advance was not 30');

-- ===========================================================================
-- 5. Full payment
--    2 weekday nights at 40 = 80; paying 80 marks it fully paid.
-- ===========================================================================
select result->>'booking_id' as r5_booking, result->>'payment_id' as r5_payment
from (select public.record_ocr_payment(
  p_business_id => :'alpha_id'::uuid,
  p_amount      => 80,
  p_method      => 'aba',
  p_property_id => :'prop_full'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-11-30 14:00+07'::timestamptz,
  p_check_out   => '2026-12-02 12:00+07'::timestamptz,
  p_payment_type => 'full',
  p_manual_entry => true
) as result) s \gset

select pg_temp.assert(
  (select payment_status from public.booking_payment_summary(:'r5_booking'::uuid)) = 'paid',
  'paying the full total was not reported as paid');
select pg_temp.assert(
  (select balance from public.booking_payment_summary(:'r5_booking'::uuid)) = 0,
  'a fully paid booking still showed a balance');

-- ===========================================================================
-- 6. Overpayment requires confirmation, and a rejected attempt takes the
--    booking it would have created down with it — the rollback test.
--    2 weekday nights at 40 = 80.
-- ===========================================================================
select pg_temp.assert(
  (select count(*) from public.bookings where property_id = :'prop_overpay'::uuid) = 0,
  'the overpayment property already had a booking before the test ran');

select pg_temp.assert_error(
  format($f$select public.record_ocr_payment(
    p_business_id => %L::uuid, p_amount => 100, p_method => 'cash',
    p_property_id => %L::uuid, p_customer_id => %L::uuid,
    p_check_in => %L::timestamptz, p_check_out => %L::timestamptz)$f$,
    :'alpha_id', :'prop_overpay', :'alpha_cust',
    '2026-12-07 14:00+07', '2026-12-09 12:00+07'),
  'overpayment', 'an overpayment was recorded without confirmation');

select pg_temp.assert(
  (select count(*) from public.bookings where property_id = :'prop_overpay'::uuid) = 0,
  'a booking survived even though the payment that would have gone with it was rejected');

-- Staff may not push past the warning even with a reason.
select pg_temp.assert_error(
  format($f$select public.record_ocr_payment(
    p_business_id => %L::uuid, p_amount => 100, p_method => 'cash',
    p_property_id => %L::uuid, p_customer_id => %L::uuid,
    p_check_in => %L::timestamptz, p_check_out => %L::timestamptz,
    p_overpayment_override => true, p_override_reason => 'guest tipped extra')$f$,
    :'alpha_id', :'prop_overpay', :'alpha_cust',
    '2026-12-07 14:00+07', '2026-12-09 12:00+07'),
  'forbidden', 'staff was allowed to override an overpayment');
reset role;

-- Owner may, with a reason, and the whole thing lands together.
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select result->>'booking_id' as r6_booking from (select public.record_ocr_payment(
  p_business_id => :'alpha_id'::uuid,
  p_amount      => 100,
  p_method      => 'cash',
  p_property_id => :'prop_overpay'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-12-07 14:00+07'::timestamptz,
  p_check_out   => '2026-12-09 12:00+07'::timestamptz,
  p_overpayment_override => true,
  p_override_reason => 'guest tipped extra',
  p_manual_entry => true
) as result) s \gset

select pg_temp.assert(
  (select payment_status from public.booking_payment_summary(:'r6_booking'::uuid)) = 'overpaid',
  'an owner-confirmed overpayment was not reported as overpaid');
reset role;

-- ===========================================================================
-- 7. Property block conflict: blocked by default, owner may override with a
--    reason, staff may not even with one.
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.property_blocks (business_id, property_id, starts_at, ends_at, reason, created_by)
values (:'alpha_id'::uuid, :'prop_block'::uuid,
        '2026-12-14 00:00+07'::timestamptz, '2026-12-16 00:00+07'::timestamptz,
        'maintenance', :alice::uuid);
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.assert_error(
  format($f$select public.record_ocr_payment(
    p_business_id => %L::uuid, p_amount => 40, p_method => 'cash',
    p_property_id => %L::uuid, p_customer_id => %L::uuid,
    p_check_in => %L::timestamptz, p_check_out => %L::timestamptz)$f$,
    :'alpha_id', :'prop_block', :'alpha_cust',
    '2026-12-14 14:00+07', '2026-12-15 12:00+07'),
  'booking_conflict', 'a booking was accepted against a maintenance block');

select pg_temp.assert_error(
  format($f$select public.record_ocr_payment(
    p_business_id => %L::uuid, p_amount => 40, p_method => 'cash',
    p_property_id => %L::uuid, p_customer_id => %L::uuid,
    p_check_in => %L::timestamptz, p_check_out => %L::timestamptz,
    p_conflict_override => true, p_conflict_reason => 'guest waited outside')$f$,
    :'alpha_id', :'prop_block', :'alpha_cust',
    '2026-12-14 14:00+07', '2026-12-15 12:00+07'),
  'forbidden', 'staff was allowed to override a block conflict');

select pg_temp.assert(
  (select count(*) from public.bookings where property_id = :'prop_block'::uuid) = 0,
  'a blocked property ended up with a booking after two rejected attempts');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select result->>'booking_id' as r7_booking from (select public.record_ocr_payment(
  p_business_id => :'alpha_id'::uuid,
  p_amount      => 40,
  p_method      => 'cash',
  p_property_id => :'prop_block'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-12-14 14:00+07'::timestamptz,
  p_check_out   => '2026-12-15 12:00+07'::timestamptz,
  p_conflict_override => true,
  p_conflict_reason => 'guest waited outside, owner let them in',
  p_manual_entry => true
) as result) s \gset
select pg_temp.assert(
  :'r7_booking' is not null, 'the owner override of a block conflict did not go through');
reset role;

-- ===========================================================================
-- 8. Booking conflict against another guest's stay: blocked by default,
--    manager may override with a reason.
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as bk_conflict from public.save_booking(
  p_business_id => :'alpha_id'::uuid, p_property_id => :'prop_conflict'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-12-21 14:00+07'::timestamptz,
  p_check_out   => '2026-12-23 12:00+07'::timestamptz) \gset
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format($f$select public.record_ocr_payment(
    p_business_id => %L::uuid, p_amount => 40, p_method => 'cash',
    p_property_id => %L::uuid, p_customer_id => %L::uuid,
    p_check_in => %L::timestamptz, p_check_out => %L::timestamptz)$f$,
    :'alpha_id', :'prop_conflict', :'alpha_cust2',
    '2026-12-22 14:00+07', '2026-12-24 12:00+07'),
  'booking_conflict', 'a second guest was booked over an existing stay');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;
select result->>'booking_id' as r8_booking from (select public.record_ocr_payment(
  p_business_id => :'alpha_id'::uuid,
  p_amount      => 40,
  p_method      => 'cash',
  p_property_id => :'prop_conflict'::uuid,
  p_customer_id => :'alpha_cust2'::uuid,
  p_check_in    => '2026-12-22 14:00+07'::timestamptz,
  p_check_out   => '2026-12-24 12:00+07'::timestamptz,
  p_conflict_override => true,
  p_conflict_reason => 'first guest agreed to leave a day early',
  p_manual_entry => true
) as result) s \gset
select pg_temp.assert(
  :'r8_booking' <> :'bk_conflict', 'the manager override did not create its own booking');
reset role;

-- ===========================================================================
-- 9. Duplicate transaction reference: blocked by default, owner may override.
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format($f$select public.record_ocr_payment(
    p_business_id => %L::uuid, p_amount => 40, p_method => 'aba',
    p_property_id => %L::uuid, p_customer_id => %L::uuid,
    p_check_in => %L::timestamptz, p_check_out => %L::timestamptz,
    p_reference => 'ABA-EXIST-1')$f$,
    :'alpha_id', :'prop_dup_ref', :'alpha_cust',
    '2026-11-02 14:00+07', '2026-11-03 12:00+07'),
  'duplicate_payment', 'a repeated transaction reference was accepted');

select pg_temp.assert(
  (select count(*) from public.bookings where property_id = :'prop_dup_ref'::uuid) = 0,
  'a booking survived a rejected duplicate-reference payment');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select result->>'payment_id' as r9_payment from (select public.record_ocr_payment(
  p_business_id => :'alpha_id'::uuid,
  p_amount      => 40,
  p_method      => 'aba',
  p_property_id => :'prop_dup_ref'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-11-02 14:00+07'::timestamptz,
  p_check_out   => '2026-11-03 12:00+07'::timestamptz,
  p_reference   => 'ABA-EXIST-1',
  p_duplicate_override => true,
  p_override_reason => 'confirmed with the bank, two genuine transfers',
  p_manual_entry => true
) as result) s \gset
select pg_temp.assert(:'r9_payment' is not null, 'the owner duplicate-reference override did not go through');
reset role;

-- ===========================================================================
-- 10. A proof already attached to another payment is its own duplicate
--     signal, independent of the reference check.
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.payment_proofs (business_id, payment_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
values (:'alpha_id'::uuid, :'r5_payment'::uuid,
        'businesses/' || :'alpha_id' || '/payments/' || :'r5_payment' || '/shot.jpg',
        'shot.jpg', 'image/jpeg', 4096, :sam::uuid)
returning id as reused_proof \gset

select pg_temp.assert_error(
  format($f$select public.record_ocr_payment(
    p_business_id => %L::uuid, p_amount => 40, p_method => 'cash',
    p_property_id => %L::uuid, p_customer_id => %L::uuid,
    p_check_in => %L::timestamptz, p_check_out => %L::timestamptz,
    p_proof_id => %L::uuid)$f$,
    :'alpha_id', :'prop_dup_proof', :'alpha_cust',
    '2026-11-30 14:00+07', '2026-12-01 12:00+07', :'reused_proof'),
  'duplicate_payment', 'a proof already on another payment was reused without warning');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select result->>'payment_id' as r10_payment from (select public.record_ocr_payment(
  p_business_id => :'alpha_id'::uuid,
  p_amount      => 40,
  p_method      => 'cash',
  p_property_id => :'prop_dup_proof'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-11-30 14:00+07'::timestamptz,
  p_check_out   => '2026-12-01 12:00+07'::timestamptz,
  p_proof_id    => :'reused_proof'::uuid,
  p_duplicate_override => true,
  p_override_reason => 'the same screenshot really does cover two stays',
  p_manual_entry => true
) as result) s \gset
select pg_temp.assert(
  (select proof_id from public.payment_ocr_reviews where payment_id = :'r10_payment'::uuid)
    = :'reused_proof'::uuid,
  'the audit row did not remember which proof this review came from');
reset role;

-- ===========================================================================
-- 11. Manual-entry fallback: no extraction, no provider, still a real
--     booking and payment, clearly marked as typed in by hand.
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select result->>'payment_id' as r11_payment from (select public.record_ocr_payment(
  p_business_id => :'alpha_id'::uuid,
  p_amount      => 50,
  p_method      => 'cash',
  p_property_id => :'prop_manual'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-12-28 14:00+07'::timestamptz,
  p_check_out   => '2026-12-30 12:00+07'::timestamptz,
  p_manual_entry => true,
  p_original_values  => '{"amount":"50"}'::jsonb,
  p_corrected_values => '{"amount":"50"}'::jsonb
) as result) s \gset

select pg_temp.assert(
  (select manual_entry from public.payment_ocr_reviews where payment_id = :'r11_payment'::uuid) = true,
  'a hand-typed payment was not marked manual_entry');
select pg_temp.assert(
  (select provider is null and extraction is null
   from public.payment_ocr_reviews where payment_id = :'r11_payment'::uuid),
  'a manual entry carried provider or extraction data it should not have');
reset role;

-- ===========================================================================
-- 12. Cross-business denial, both directions.
-- ===========================================================================
-- BETA's owner has no membership in ALPHA: has_business_permission says no,
-- whatever booking or property id rides along.
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format($f$select public.record_ocr_payment(
    p_business_id => %L::uuid, p_amount => 10, p_method => 'cash',
    p_booking_id => %L::uuid)$f$,
    :'alpha_id', :'bk_existing'),
  'forbidden', 'a non-member of ALPHA was allowed to record an ALPHA payment');
reset role;

-- ALPHA's owner, correctly scoped to her own business, naming BETA's booking:
-- the booking simply is not hers to find.
select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format($f$select public.record_ocr_payment(
    p_business_id => %L::uuid, p_amount => 10, p_method => 'cash',
    p_booking_id => %L::uuid)$f$,
    :'alpha_id', :'beta_bk'),
  'booking_not_found', 'a booking from another business was reachable by id alone');
reset role;

-- Nobody outside ALPHA can see the audit trail ALPHA's tests just wrote.
select set_config('request.jwt.claims',
  json_build_object('sub', :stan, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  (select count(*) from public.payment_ocr_reviews where business_id = :'alpha_id'::uuid) = 0,
  'BETA staff read ALPHA''s OCR review audit trail');
reset role;

select 'ALL PHASE 6C OCR/BOOKING/PAYMENT TESTS PASSED' as result;

rollback;
