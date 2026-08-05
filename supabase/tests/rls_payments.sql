-- =============================================================================
-- Phase 5 tenant isolation suite: payments, proofs, adjustments and receipts.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_payments.sql
--
-- Same shape as the Phase 1-4 suites: one rolled-back transaction, two
-- unrelated businesses, five users, and an assertion helper that cannot pass
-- silently. Both businesses hold money, so "I saw 0 rows" is never a false
-- pass — every cross-tenant read is asserted against payments that
-- demonstrably exist on the other side.
--
-- The running arithmetic on ALPHA's first booking (total 120, deposit 60) is
-- tracked in comments at each step, because most of what this file proves is
-- that the totals move the way the rules say they do.
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

-- ALPHA booking: Mon 7 Sep to Thu 10 Sep 2026, three weekday nights at 40 = 120.
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as bk1 from public.save_booking(
  p_business_id => :'alpha_id'::uuid,
  p_property_id => :'alpha_prop'::uuid,
  p_customer_id => :'alpha_cust'::uuid,
  p_check_in    => '2026-09-07 14:00+07'::timestamptz,
  p_check_out   => '2026-09-10 12:00+07'::timestamptz,
  p_source      => 'facebook') \gset
reset role;

-- BETA booking: two nights at 100 = 200. Money on both sides, always.
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as bk_beta from public.save_booking(
  p_business_id => :'beta_id'::uuid,
  p_property_id => :'beta_prop'::uuid,
  p_customer_id => :'beta_cust'::uuid,
  p_check_in    => '2026-09-07 14:00+07'::timestamptz,
  p_check_out   => '2026-09-09 12:00+07'::timestamptz) \gset
select id as beta_pay from public.record_payment(
  p_booking_id => :'bk_beta'::uuid, p_amount => 100, p_method => 'cash') \gset
select id as beta_receipt, receipt_number as beta_receipt_number
  from public.issue_receipt(:'bk_beta'::uuid, :'beta_pay'::uuid, 'en') \gset
reset role;

select id as alpha_pending from public.booking_statuses
  where business_id = :'alpha_id'::uuid and code = 'pending' and is_system \gset

-- ===========================================================================
-- 1. A booking with no payments owes everything
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.assert(
  (select booking_total from public.booking_payment_summary(:'bk1'::uuid)) = 120,
  'the summary did not take the booking total from final_price');
select pg_temp.assert(
  (select deposit_required from public.booking_payment_summary(:'bk1'::uuid)) = 60,
  'the required deposit was not half the booking total');
select pg_temp.assert(
  (select payment_status from public.booking_payment_summary(:'bk1'::uuid)) = 'unpaid',
  'a booking with no payments was not unpaid');
select pg_temp.assert(
  (select balance from public.booking_payment_summary(:'bk1'::uuid)) = 120,
  'the outstanding balance was not the whole total');
select pg_temp.assert(
  (select currency from public.booking_payment_summary(:'bk1'::uuid)) = 'KHR',
  'the summary did not keep the booking currency');

-- ===========================================================================
-- 2. Staff may record a payment below the deposit, and it is not rejected
--    net 0 -> 20 : partial
-- ===========================================================================
select id as p1 from public.record_payment(
  p_booking_id => :'bk1'::uuid,
  p_amount     => 20,
  p_method     => 'aba',
  p_payment_type => 'deposit',
  p_payer_name => 'Sok Dara',
  p_note       => 'Messenger screenshot') \gset

select pg_temp.assert(
  (select payment_number from public.payments where id = :'p1'::uuid) = 'PM-2026-000001',
  'the first payment of the year was not numbered PM-2026-000001');
select pg_temp.assert(
  (select status from public.payments where id = :'p1'::uuid) = 'recorded',
  'a new payment did not start as recorded');
select pg_temp.assert(
  (select created_by from public.payments where id = :'p1'::uuid) = :sam::uuid,
  'created_by was not stamped with the caller');
-- The client never says which booking, customer, business or currency: the
-- booking does.
select pg_temp.assert(
  (select customer_id from public.payments where id = :'p1'::uuid) = :'alpha_cust'::uuid,
  'the payment did not take the customer from the booking');
select pg_temp.assert(
  (select currency from public.payments where id = :'p1'::uuid) = 'KHR'
  and (select business_id from public.payments where id = :'p1'::uuid) = :'alpha_id'::uuid,
  'the payment did not take the currency and business from the booking');

select pg_temp.assert(
  (select payment_status from public.booking_payment_summary(:'bk1'::uuid)) = 'partial',
  '20 of 120 was not reported as a partial payment');
select pg_temp.assert(
  (select paid_percent from public.booking_payment_summary(:'bk1'::uuid)) = 16.67,
  'the paid percentage was not 20/120');
-- Below the deposit line, so the hold has not turned into a confirmation.
select pg_temp.assert(
  (select s.code from public.bookings b join public.booking_statuses s on s.id = b.status_id
   where b.id = :'bk1'::uuid) = 'pending',
  'a booking was confirmed before the deposit arrived');

-- Nothing valid is rejected, but nothing invalid is accepted either.
select pg_temp.assert_error(
  format('select public.record_payment(%L, 0, %L)', :'bk1', 'cash'),
  'invalid_amount', 'a zero payment was accepted');
select pg_temp.assert_error(
  format('select public.record_payment(%L, -5, %L)', :'bk1', 'cash'),
  'invalid_amount', 'a negative payment was accepted');
select pg_temp.assert_error(
  format($f$select public.record_payment(%L, 5, 'cash', 'refund')$f$, :'bk1'),
  'invalid_payment_type', 'a refund was typed in by hand as a payment');

-- ===========================================================================
-- 3. Reaching the deposit confirms a pending booking automatically
--    net 20 -> 60 : deposit_paid
-- ===========================================================================
select id as p2 from public.record_payment(
  p_booking_id => :'bk1'::uuid,
  p_amount     => 40,
  p_method     => 'khqr',
  p_payment_type => 'deposit',
  p_reference  => 'ABA-123') \gset

select pg_temp.assert(
  (select payment_number from public.payments where id = :'p2'::uuid) = 'PM-2026-000002',
  'the payment number did not advance');
select pg_temp.assert(
  (select payment_status from public.booking_payment_summary(:'bk1'::uuid)) = 'deposit_paid',
  'reaching half the total was not reported as deposit paid');
select pg_temp.assert(
  (select s.code from public.bookings b join public.booking_statuses s on s.id = b.status_id
   where b.id = :'bk1'::uuid) = 'confirmed',
  'the booking was not confirmed when the deposit was reached');
select pg_temp.assert(
  (select pending_expires_at is null and pending_resolved_at is null
   from public.bookings where id = :'bk1'::uuid),
  'the pending hold was left open after confirmation');
-- The move was logged like any other status change.
select pg_temp.assert(
  (select count(*) from public.booking_status_history where booking_id = :'bk1'::uuid) = 2,
  'the automatic confirmation was not written to the status history');

-- ===========================================================================
-- 4. Duplicate transaction references are blocked, and staff cannot override
-- ===========================================================================
select pg_temp.assert(
  jsonb_array_length(public.payment_duplicates(:'alpha_id'::uuid, 'ABA-123')) = 1,
  'a known reference was not reported as a duplicate');
-- Case and padding are not a way around it.
select pg_temp.assert(
  jsonb_array_length(public.payment_duplicates(:'alpha_id'::uuid, '  aba-123 ')) = 1,
  'a duplicate reference slipped past on case or whitespace');
select pg_temp.assert(
  public.payment_duplicates(:'alpha_id'::uuid, 'ABA-123')->0->>'kind' = 'reference',
  'the duplicate was not reported as a reference match');

select pg_temp.assert_error(
  format($f$select public.record_payment(%L, 10, 'aba', 'balance', null, 'ABA-123')$f$, :'bk1'),
  'duplicate_payment', 'a repeated transaction reference was accepted');

-- Staff may not push past it, with or without a reason.
select pg_temp.assert_error(
  format($f$select public.record_payment(%L, 10, 'aba', 'balance', null, 'ABA-123',
            p_duplicate_override => true, p_override_reason => 'guest sent it twice')$f$, :'bk1'),
  'forbidden', 'staff overrode a duplicate payment warning');
reset role;

-- ===========================================================================
-- 5. A manager may override, but only with a reason
--    net 60 -> 70 : deposit_paid
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.assert_error(
  format($f$select public.record_payment(%L, 10, 'aba', 'balance', null, 'ABA-123',
            p_duplicate_override => true)$f$, :'bk1'),
  'override_reason_required', 'a duplicate was overridden without a reason');
select pg_temp.assert_error(
  format($f$select public.record_payment(%L, 10, 'aba', 'balance', null, 'ABA-123',
            p_duplicate_override => true, p_override_reason => 'ok')$f$, :'bk1'),
  'override_reason_required', 'a two-character reason counted as a reason');

select id as p3 from public.record_payment(
  p_booking_id => :'bk1'::uuid,
  p_amount     => 10,
  p_method     => 'aba',
  p_payment_type => 'balance',
  p_reference  => 'ABA-123',
  p_duplicate_override => true,
  p_override_reason    => 'guest really did send it twice') \gset

select pg_temp.assert(
  (select duplicate_override and override_reason is not null
   from public.payments where id = :'p3'::uuid),
  'the override and its reason were not recorded on the payment');
select pg_temp.assert(
  (select net_paid from public.booking_payment_summary(:'bk1'::uuid)) = 70,
  'the overridden payment did not count towards the balance');

-- ===========================================================================
-- 6. Overpayment needs a senior confirmation, then shows as overpaid
--    net 70 -> 170 : overpaid, then voided back to 70
-- ===========================================================================
select pg_temp.assert_error(
  format($f$select public.record_payment(%L, 100, 'cash')$f$, :'bk1'),
  'overpayment', 'more than the booking total was accepted without a warning');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format($f$select public.record_payment(%L, 100, 'cash', 'full', null, null, null, null,
            p_overpayment_override => true, p_override_reason => 'guest paid extra')$f$, :'bk1'),
  'forbidden', 'staff overrode an overpayment warning');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select id as p4 from public.record_payment(
  p_booking_id => :'bk1'::uuid,
  p_amount     => 100,
  p_method     => 'cash',
  p_payment_type => 'full',
  p_overpayment_override => true,
  p_override_reason      => 'guest insisted on paying a tip') \gset

select pg_temp.assert(
  (select payment_status from public.booking_payment_summary(:'bk1'::uuid)) = 'overpaid',
  'paying past the total was not reported as overpaid');
select pg_temp.assert(
  (select balance from public.booking_payment_summary(:'bk1'::uuid)) = -50,
  'the balance did not go negative on an overpayment');

-- ===========================================================================
-- 7. Void: owner only, keeps the row, stops it counting
--    net 170 -> 70 : deposit_paid
-- ===========================================================================
reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format($f$select public.void_payment(%L, 'entered by mistake')$f$, :'p4'),
  'forbidden', 'a manager voided a payment');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format($f$select public.void_payment(%L, 'entered by mistake')$f$, :'p4'),
  'forbidden', 'staff voided a payment');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format($f$select public.void_payment(%L, 'no')$f$, :'p4'),
  'reason_required', 'a payment was voided without a reason');

select public.void_payment(:'p4'::uuid, 'guest changed their mind about the tip');

-- The row is still there. Nothing in this phase deletes money.
select pg_temp.assert(
  (select status from public.payments where id = :'p4'::uuid) = 'voided',
  'a voided payment did not keep its row with status voided');
select pg_temp.assert(
  (select count(*) from public.payment_adjustments
   where payment_id = :'p4'::uuid and action = 'void') = 1,
  'voiding did not write an audit record');
select pg_temp.assert(
  (select original_amount from public.payment_adjustments
   where payment_id = :'p4'::uuid and action = 'void') = 100,
  'the void audit record did not keep the original amount');
select pg_temp.assert(
  (select net_paid from public.booking_payment_summary(:'bk1'::uuid)) = 70
  and (select payment_status from public.booking_payment_summary(:'bk1'::uuid)) = 'deposit_paid',
  'a voided payment kept counting towards the balance');
-- And its reference is free again, because the partial unique index skips it.
select pg_temp.assert(
  jsonb_array_length(public.payment_duplicates(:'alpha_id'::uuid, 'ABA-999')) = 0,
  'an unused reference was reported as a duplicate');
reset role;

-- ===========================================================================
-- 8. Verify and correct
--    net 70 -> 80 (p1 corrected 20 -> 30) : deposit_paid
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format('select public.verify_payment(%L)', :'p1'),
  'forbidden', 'staff verified a payment');
select pg_temp.assert_error(
  format($f$select public.correct_payment(%L, 30, 'typed the wrong amount')$f$, :'p1'),
  'forbidden', 'staff corrected a payment');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :mark, 'role', 'authenticated')::text, true);
set local role authenticated;

select public.verify_payment(:'p1'::uuid);
select pg_temp.assert(
  (select status from public.payments where id = :'p1'::uuid) = 'verified'
  and (select verified_by from public.payments where id = :'p1'::uuid) = :mark::uuid
  and (select verified_at is not null from public.payments where id = :'p1'::uuid),
  'verifying did not stamp the row');

select pg_temp.assert_error(
  format($f$select public.correct_payment(%L, 30, 'no')$f$, :'p1'),
  'reason_required', 'a payment was corrected without a reason');
select pg_temp.assert_error(
  format($f$select public.correct_payment(%L, 0, 'typed the wrong amount')$f$, :'p1'),
  'invalid_amount', 'a payment was corrected to zero');

select public.correct_payment(:'p1'::uuid, 30, 'guest actually sent 30, not 20');

select pg_temp.assert(
  (select amount from public.payments where id = :'p1'::uuid) = 30,
  'the correction did not change the amount');
-- An amount that changed after somebody checked it has not been checked.
select pg_temp.assert(
  (select status from public.payments where id = :'p1'::uuid) = 'recorded'
  and (select verified_by is null and verified_at is null
       from public.payments where id = :'p1'::uuid),
  'a corrected payment kept its verification');
select pg_temp.assert(
  (select original_amount = 20 and corrected_amount = 30
   from public.payment_adjustments where payment_id = :'p1'::uuid and action = 'correct'),
  'the correction did not keep both the old and the new amount');
select pg_temp.assert(
  (select net_paid from public.booking_payment_summary(:'bk1'::uuid)) = 80,
  'the corrected amount is not what the balance uses');

-- ===========================================================================
-- 9. Refund: its own row, subtracted from the net, original untouched
--    net 80 -> 50 : partial
-- ===========================================================================
select pg_temp.assert_error(
  format($f$select public.refund_payment(%L, 31, 'guest cancelled')$f$, :'p1'),
  'invalid_amount', 'more was refunded than the payment held');
select pg_temp.assert_error(
  format($f$select public.refund_payment(%L, 30, 'no')$f$, :'p1'),
  'reason_required', 'a refund was issued without a reason');

select id as p5 from public.refund_payment(:'p1'::uuid, 30, 'guest cancelled one night') \gset

select pg_temp.assert(
  (select payment_type from public.payments where id = :'p5'::uuid) = 'refund'
  and (select amount from public.payments where id = :'p5'::uuid) = 30,
  'the refund was not recorded as a positive refund row');
select pg_temp.assert(
  (select amount from public.payments where id = :'p1'::uuid) = 30,
  'refunding edited the original payment');
select pg_temp.assert(
  (select status from public.payments where id = :'p1'::uuid) = 'refunded',
  'a fully refunded payment was not marked refunded');
select pg_temp.assert(
  (select refund_payment_id from public.payment_adjustments
   where payment_id = :'p1'::uuid and action = 'refund') = :'p5'::uuid,
  'the refund audit record did not link the refund row');
select pg_temp.assert(
  (select total_paid from public.booking_payment_summary(:'bk1'::uuid)) = 80
  and (select refund_total from public.booking_payment_summary(:'bk1'::uuid)) = 30
  and (select net_paid from public.booking_payment_summary(:'bk1'::uuid)) = 50,
  'the refund did not come off the net while leaving total_paid alone');
select pg_temp.assert(
  (select payment_status from public.booking_payment_summary(:'bk1'::uuid)) = 'partial',
  'dropping below the deposit after a refund was not reported as partial');

-- Nothing is left to refund on that payment now.
select pg_temp.assert_error(
  format($f$select public.refund_payment(%L, 1, 'once more')$f$, :'p1'),
  'invalid_amount', 'a payment was refunded past its own amount');
-- A refund row is not itself refundable.
select pg_temp.assert_error(
  format($f$select public.refund_payment(%L, 1, 'refund of a refund')$f$, :'p5'),
  'invalid_payment_type', 'a refund row was refunded');
reset role;

-- ===========================================================================
-- 10. Proofs: staff may upload, nobody may delete, and the path must match
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;

insert into public.payment_proofs (
  business_id, payment_id, storage_path, file_name, mime_type, size_bytes, checksum, uploaded_by)
values (:'alpha_id'::uuid, :'p2'::uuid,
        'businesses/' || :'alpha_id' || '/payments/' || :'p2' || '/shot.jpg',
        'shot.jpg', 'image/jpeg', 4096,
        repeat('a', 64), :sam::uuid);

select pg_temp.assert(
  (select count(*) from public.payment_proofs where payment_id = :'p2'::uuid) = 1,
  'staff could not upload a payment proof');

-- The same file again is a warning, not a block.
select pg_temp.assert(
  jsonb_array_length(public.payment_duplicates(
    :'alpha_id'::uuid, null, null, null, repeat('a', 64))) = 1,
  'a repeated file checksum was not reported');
select pg_temp.assert(
  public.payment_duplicates(:'alpha_id'::uuid, null, null, null, repeat('a', 64))->0->>'kind'
    = 'file',
  'the checksum match was not reported as a file match');

-- A proof must sit under its own business prefix, whatever the client says.
select pg_temp.assert_rejected(
  format($f$insert into public.payment_proofs
            (business_id, payment_id, storage_path, file_name, mime_type, size_bytes)
            values (%L, %L, 'businesses/%s/payments/%s/evil.jpg',
                    'evil.jpg', 'image/jpeg', 10)$f$,
         :'alpha_id', :'p2', :'beta_id', :'p2'),
  'a proof was stored under another business prefix');
-- And it must belong to a payment of the same business.
select pg_temp.assert_rejected(
  format($f$insert into public.payment_proofs
            (business_id, payment_id, storage_path, file_name, mime_type, size_bytes)
            values (%L, %L, 'businesses/%s/payments/%s/x.jpg', 'x.jpg', 'image/jpeg', 10)$f$,
         :'alpha_id', :'beta_pay', :'alpha_id', :'beta_pay'),
  'a proof was attached to another business payment');
-- Evidence is not deletable, by anybody.
select pg_temp.assert_rejected(
  format('delete from public.payment_proofs where payment_id = %L', :'p2'),
  'a payment proof was deleted');

-- ===========================================================================
-- 11. No client-side writes to money, whatever the role
-- ===========================================================================
select pg_temp.assert_rejected(
  format($f$update public.payments set amount = 1 where id = %L$f$, :'p2'),
  'a payment amount was edited directly');
select pg_temp.assert_rejected(
  format($f$delete from public.payments where id = %L$f$, :'p2'),
  'a payment was deleted directly');
select pg_temp.assert_rejected(
  format($f$insert into public.payments
            (business_id, booking_id, customer_id, payment_number, amount, currency,
             method, payment_type, paid_at)
            values (%L, %L, %L, 'PM-2026-999999', 1, 'KHR', 'cash', 'deposit', now())$f$,
         :'alpha_id', :'bk1', :'alpha_cust'),
  'a payment row was inserted straight into the table');
select pg_temp.assert_rejected(
  format($f$insert into public.payment_adjustments
            (business_id, payment_id, action, reason, original_amount)
            values (%L, %L, 'void', 'because I said so', 1)$f$, :'alpha_id', :'p2'),
  'an audit record was written by a client');
select pg_temp.assert_rejected(
  format($f$update public.payment_adjustments set reason = 'edited'
            where payment_id = %L$f$, :'p1'),
  'an audit record was edited');
select pg_temp.assert_rejected(
  'select * from public.payment_counters',
  'a client read the payment number counter');
select pg_temp.assert_rejected(
  format($f$select public.next_payment_number(%L, now(), 'Asia/Phnom_Penh')$f$, :'alpha_id'),
  'a client burned a payment number');
reset role;

-- ===========================================================================
-- 12. Receipts: owner and manager only, numbered per business, frozen
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert_error(
  format($f$select public.issue_receipt(%L, %L, 'km')$f$, :'bk1', :'p2'),
  'forbidden', 'staff issued a receipt');
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', :alice, 'role', 'authenticated')::text, true);
set local role authenticated;

select id as rc1 from public.issue_receipt(:'bk1'::uuid, :'p2'::uuid, 'km') \gset

select pg_temp.assert(
  (select receipt_number from public.receipts where id = :'rc1'::uuid) = 'RC-2026-000001',
  'the first receipt of the year was not numbered RC-2026-000001');
-- BETA already issued its own first receipt: the sequences are per business.
-- (Its number was captured at issue time; ALPHA cannot read BETA's rows.)
select pg_temp.assert(
  :'beta_receipt_number' = 'RC-2026-000001',
  'the receipt sequence is shared between businesses');
select pg_temp.assert(
  (select language from public.receipts where id = :'rc1'::uuid) = 'km',
  'the receipt did not keep the language it was issued in');
select pg_temp.assert(
  (select issued_by from public.receipts where id = :'rc1'::uuid) = :alice::uuid,
  'the receipt did not record who issued it');

select pg_temp.assert(
  (select snapshot->>'customer_name' from public.receipts where id = :'rc1'::uuid) = 'សុខ ដារា'
  and (select snapshot->>'property_name' from public.receipts where id = :'rc1'::uuid)
      = 'Alpha Riverside Villa'
  and (select snapshot->>'business_name' from public.receipts where id = :'rc1'::uuid)
      = 'Alpha Homestay',
  'the receipt snapshot is missing the names it must show');
select pg_temp.assert(
  (select (snapshot->>'booking_total')::numeric from public.receipts where id = :'rc1'::uuid) = 120
  and (select (snapshot->>'net_paid')::numeric from public.receipts where id = :'rc1'::uuid) = 50
  and (select (snapshot->>'payment_amount')::numeric from public.receipts where id = :'rc1'::uuid)
      = 40,
  'the receipt snapshot did not freeze the totals as they stood');

-- Rename everything the receipt names. The receipt must not move.
update public.properties set name = 'Renamed Villa' where id = :'alpha_prop'::uuid;
update public.customers  set full_name = 'Someone Else' where id = :'alpha_cust'::uuid;
update public.businesses set name = 'Alpha Renamed' where id = :'alpha_id'::uuid;

select pg_temp.assert(
  (select snapshot->>'property_name' from public.receipts where id = :'rc1'::uuid)
    = 'Alpha Riverside Villa'
  and (select snapshot->>'customer_name' from public.receipts where id = :'rc1'::uuid) = 'សុខ ដារា'
  and (select snapshot->>'business_name' from public.receipts where id = :'rc1'::uuid)
      = 'Alpha Homestay',
  'editing a property, customer or business changed a receipt already issued');

select pg_temp.assert_rejected(
  format($f$update public.receipts set snapshot = '{}'::jsonb where id = %L$f$, :'rc1'),
  'a receipt was edited after being issued');
select pg_temp.assert_rejected(
  format('delete from public.receipts where id = %L', :'rc1'),
  'a receipt was deleted');
-- A receipt is a financial reference: the payment under it cannot be dropped.
select pg_temp.assert_rejected(
  format('delete from public.bookings where id = %L', :'bk1'),
  'a booking with receipts and payments was deleted');
reset role;

-- ===========================================================================
-- 13. Tenant isolation — ALPHA and BETA both hold money, neither sees the other
-- ===========================================================================
select set_config('request.jwt.claims',
  json_build_object('sub', :bella, 'role', 'authenticated')::text, true);
set local role authenticated;

-- BETA's owner sees exactly BETA's payments, and no more.
select pg_temp.assert(
  (select count(*) from public.payments) = 1,
  'BETA saw payments other than its own');
select pg_temp.assert(
  (select count(*) from public.payments where business_id = :'alpha_id'::uuid) = 0,
  'BETA read ALPHA payments');
select pg_temp.assert(
  (select count(*) from public.payment_proofs where business_id = :'alpha_id'::uuid) = 0,
  'BETA read ALPHA payment proofs');
select pg_temp.assert(
  (select count(*) from public.payment_adjustments where business_id = :'alpha_id'::uuid) = 0,
  'BETA read ALPHA payment adjustments');
select pg_temp.assert(
  (select count(*) from public.receipts where business_id = :'alpha_id'::uuid) = 0,
  'BETA read ALPHA receipts');
select pg_temp.assert(
  (select count(*) from public.booking_payment_totals where business_id = :'alpha_id'::uuid) = 0,
  'BETA read ALPHA booking balances through the totals view');
select pg_temp.assert(
  (select count(*) from public.booking_payment_summary(:'bk1'::uuid)) = 0,
  'BETA read an ALPHA booking summary');

-- Nor may it write anything of ALPHA's, whatever it passes in.
select pg_temp.assert_error(
  format($f$select public.record_payment(%L, 10, 'cash')$f$, :'bk1'),
  'forbidden', 'BETA recorded a payment against an ALPHA booking');
select pg_temp.assert_error(
  format('select public.verify_payment(%L)', :'p2'),
  'forbidden', 'BETA verified an ALPHA payment');
select pg_temp.assert_error(
  format($f$select public.void_payment(%L, 'not mine')$f$, :'p2'),
  'forbidden', 'BETA voided an ALPHA payment');
select pg_temp.assert_error(
  format($f$select public.correct_payment(%L, 5, 'not mine')$f$, :'p2'),
  'forbidden', 'BETA corrected an ALPHA payment');
select pg_temp.assert_error(
  format($f$select public.refund_payment(%L, 5, 'not mine')$f$, :'p2'),
  'forbidden', 'BETA refunded an ALPHA payment');
select pg_temp.assert_error(
  format($f$select public.issue_receipt(%L, null, 'en')$f$, :'bk1'),
  'forbidden', 'BETA issued a receipt on an ALPHA booking');
select pg_temp.assert_error(
  format($f$select public.payment_duplicates(%L, 'ABA-123')$f$, :'alpha_id'),
  'forbidden', 'BETA searched ALPHA payments for duplicates');
select pg_temp.assert_rejected(
  format($f$insert into public.payment_proofs
            (business_id, payment_id, storage_path, file_name, mime_type, size_bytes)
            values (%L, %L, 'businesses/%s/payments/%s/x.jpg', 'x.jpg', 'image/jpeg', 10)$f$,
         :'alpha_id', :'p2', :'alpha_id', :'p2'),
  'BETA attached a proof to an ALPHA payment');

-- BETA's staff is no more privileged across the fence than its owner.
reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', :stan, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  (select count(*) from public.payments where business_id = :'alpha_id'::uuid) = 0,
  'BETA staff read ALPHA payments');
select pg_temp.assert(
  (select count(*) from public.payments where business_id = :'beta_id'::uuid) = 1,
  'BETA staff could not read its own business payments');
select pg_temp.assert_error(
  format($f$select public.record_payment(%L, 10, 'cash')$f$, :'bk1'),
  'forbidden', 'BETA staff recorded a payment on an ALPHA booking');
reset role;

-- A suspended member keeps nothing: the business is only "theirs" while active.
update public.business_members set status = 'suspended'
where business_id = :'alpha_id'::uuid and user_id = :sam::uuid;

select set_config('request.jwt.claims',
  json_build_object('sub', :sam, 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.assert(
  (select count(*) from public.payments) = 0,
  'a suspended member still read the payments');
select pg_temp.assert_error(
  format($f$select public.record_payment(%L, 10, 'cash')$f$, :'bk1'),
  'forbidden', 'a suspended member recorded a payment');
reset role;

update public.business_members set status = 'active'
where business_id = :'alpha_id'::uuid and user_id = :sam::uuid;

-- ===========================================================================
-- 14. Anonymous callers get nothing at all
-- ===========================================================================
select set_config('request.jwt.claims', '', true);
set local role anon;

select pg_temp.assert_rejected('select * from public.payments', 'anon read payments');
select pg_temp.assert_rejected('select * from public.payment_proofs', 'anon read payment proofs');
select pg_temp.assert_rejected('select * from public.receipts', 'anon read receipts');
select pg_temp.assert_rejected(
  'select * from public.booking_payment_totals', 'anon read booking balances');
select pg_temp.assert_rejected(
  format('select * from public.booking_payment_summary(%L)', :'bk1'),
  'anon read a booking summary');
select pg_temp.assert_rejected(
  format($f$select public.record_payment(%L, 10, 'cash')$f$, :'bk1'),
  'anon recorded a payment');
select pg_temp.assert_rejected(
  format('select public.verify_payment(%L)', :'p2'), 'anon verified a payment');
select pg_temp.assert_rejected(
  format($f$select public.void_payment(%L, 'anon')$f$, :'p2'), 'anon voided a payment');
select pg_temp.assert_rejected(
  format($f$select public.correct_payment(%L, 5, 'anon')$f$, :'p2'), 'anon corrected a payment');
select pg_temp.assert_rejected(
  format($f$select public.refund_payment(%L, 5, 'anon')$f$, :'p2'), 'anon refunded a payment');
select pg_temp.assert_rejected(
  format($f$select public.issue_receipt(%L, null, 'en')$f$, :'bk1'), 'anon issued a receipt');
select pg_temp.assert_rejected(
  format($f$select public.payment_duplicates(%L, 'ABA-123')$f$, :'alpha_id'),
  'anon searched for duplicate payments');
select pg_temp.assert_rejected(
  format('select public.confirm_on_deposit(%L)', :'bk1'),
  'anon called the internal confirmation helper');
reset role;

select 'ALL PAYMENT RLS TESTS PASSED' as result;

rollback;
