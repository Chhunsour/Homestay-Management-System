-- =============================================================================
-- Phase 5 RPCs: every write that touches money.
--
-- The client is never trusted with five things: which booking and customer a
-- payment belongs to, which currency it is in, whether a reference is already
-- taken, whether the total now exceeds what the stay costs, and whether the
-- caller may push past either warning. All five are decided here, inside the
-- transaction, after re-reading the booking.
--
-- Errors follow the existing contract: auth_required (28000), forbidden
-- (42501), *_not_found (P0002), validation (22023). duplicate_payment uses
-- 23505 and carries the offending payment in DETAIL; overpayment uses 22023
-- and carries the arithmetic.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- payment_duplicates : "have I seen this money before?"
--
-- Three independent signals, weakest first:
--   * same file          — the identical screenshot was uploaded already
--   * same time + amount — the same sum inside PAYMENT_DUPLICATE_WINDOW
--   * same reference     — the same transaction id, which is the hard block
--
-- Read-only, and safe to call before saving: the screen uses it to warn, and
-- record_payment repeats the reference test itself rather than trusting that
-- the warning was shown.
-- ---------------------------------------------------------------------------
create or replace function public.payment_duplicates(
  p_business_id uuid,
  p_reference   text    default null,
  p_amount      numeric default null,
  p_paid_at     timestamptz default null,
  p_checksum    text    default null,
  p_exclude     uuid    default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;
  if not public.has_business_permission(p_business_id, 'payments.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row order by row->>'paid_at' desc), '[]'::jsonb)
  into v_rows
  from (
    select jsonb_build_object(
      'kind', case
                when p_reference is not null
                 and lower(btrim(p.reference)) = lower(btrim(p_reference)) then 'reference'
                when p_checksum is not null and pr.id is not null then 'file'
                else 'amount'
              end,
      'id', p.id,
      'payment_number', p.payment_number,
      'amount', p.amount,
      'currency', p.currency,
      'paid_at', p.paid_at,
      'reference', p.reference,
      'status', p.status
    ) as row
    from public.payments p
    left join public.payment_proofs pr
      on pr.payment_id = p.id and p_checksum is not null and pr.checksum = p_checksum
    where p.business_id = p_business_id
      and p.status <> 'voided'
      and (p_exclude is null or p.id <> p_exclude)
      and (
        (p_reference is not null and lower(btrim(p.reference)) = lower(btrim(p_reference)))
        or pr.id is not null
        or (
          p_amount is not null and p_paid_at is not null
          and p.amount = p_amount
          -- Two identical sums within the window are worth a second look; the
          -- same sum a week apart is just a guest paying in instalments.
          and p.paid_at between p_paid_at - interval '30 minutes'
                            and p_paid_at + interval '30 minutes'
        )
      )
    limit 20
  ) matches;

  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_on_deposit : a pending booking whose deposit has arrived is a
-- confirmed booking. Internal; the caller has already checked permissions.
--
-- The status change goes through a plain UPDATE rather than set_booking_status
-- because the dates are already held by the pending row — there is nothing new
-- to conflict with, and the log_booking_status trigger still records the move.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_on_deposit(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_summary   record;
  v_business  uuid;
  v_code      public.booking_status_code;
  v_confirmed uuid;
begin
  select b.business_id, s.code into v_business, v_code
  from public.bookings b
  join public.booking_statuses s on s.id = b.status_id
  where b.id = p_booking_id;

  if v_code is distinct from 'pending' then
    return;
  end if;

  select * into v_summary from public.booking_payment_summary(p_booking_id);
  if v_summary.net_paid < v_summary.deposit_required then
    return;
  end if;

  select id into v_confirmed
  from public.booking_statuses
  where business_id = v_business and code = 'confirmed' and is_system;

  if v_confirmed is null then
    return;                      -- an owner deactivated it; leave the booking alone
  end if;

  -- The status trigger clears the hold columns on the way out of pending.
  update public.bookings
  set status_id = v_confirmed
  where id = p_booking_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_payment : the one way a payment row comes into existence.
--
-- Deposit, part payment, balance, full payment — all the same insert. The type
-- is a label for the receipt, not a rule: a guest who sends 30% is recorded as
-- having sent 30%, and the booking simply stays partially paid. Nothing here
-- rejects a valid payment for being the wrong size.
-- ---------------------------------------------------------------------------
create or replace function public.record_payment(
  p_booking_id  uuid,
  p_amount      numeric,
  p_method      public.payment_method,
  p_payment_type public.payment_type default 'deposit',
  p_paid_at     timestamptz default null,
  p_reference   text default null,
  p_payer_name  text default null,
  p_note        text default null,
  p_duplicate_override   boolean default false,
  p_overpayment_override boolean default false,
  p_override_reason      text default null
)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user      uuid := auth.uid();
  v_booking   public.bookings;
  v_summary   record;
  v_payment   public.payments;
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_paid_at   timestamptz := coalesce(p_paid_at, now());
  v_timezone  text;
  v_existing  jsonb;
  v_reason    text := btrim(coalesce(p_override_reason, ''));
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id;
  if v_booking.id is null then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  if not public.has_business_permission(v_booking.business_id, 'payments.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_payment_type = 'refund' then
    -- Refunds carry their own audit row; they cannot be typed in by hand.
    raise exception 'invalid_payment_type' using errcode = '22023';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  -- One writer per booking while the totals are being read and re-checked, so
  -- two people recording the same deposit cannot both see "nothing paid yet".
  perform pg_advisory_xact_lock(hashtextextended(p_booking_id::text, 0));

  -- Duplicate transaction reference: blocked by default for everybody.
  if v_reference is not null and not p_duplicate_override then
    select public.payment_duplicates(v_booking.business_id, v_reference) into v_existing;
    if jsonb_array_length(v_existing) > 0 then
      raise exception 'duplicate_payment' using errcode = '23505', detail = v_existing::text;
    end if;
  end if;

  if (p_duplicate_override or p_overpayment_override) then
    if not public.has_business_permission(v_booking.business_id, 'payments.override') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if char_length(v_reason) < 3 then
      raise exception 'override_reason_required' using errcode = '22023';
    end if;
  end if;

  select * into v_summary from public.booking_payment_summary(p_booking_id);

  -- More money than the stay costs is usually a typo, occasionally a tip.
  -- Either way somebody senior says so in writing before it is recorded.
  if round(v_summary.net_paid + p_amount, 2) > v_summary.booking_total
     and not p_overpayment_override then
    raise exception 'overpayment' using errcode = '22023',
      detail = jsonb_build_object(
        'booking_total', v_summary.booking_total,
        'net_paid', v_summary.net_paid,
        'amount', p_amount,
        'currency', v_summary.currency)::text;
  end if;

  select timezone into v_timezone from public.business_settings where business_id = v_booking.business_id;

  insert into public.payments (
    business_id, booking_id, customer_id, payment_number,
    amount, currency, exchange_rate, method, payment_type, status,
    paid_at, reference, payer_name, note,
    duplicate_override, overpayment_override, override_reason, created_by
  )
  values (
    v_booking.business_id, v_booking.id,
    -- Never the client's customer id: the booking already knows whose stay it is.
    v_booking.customer_id,
    public.next_payment_number(v_booking.business_id, v_paid_at, coalesce(v_timezone, 'UTC')),
    round(p_amount, 2), v_booking.currency, v_booking.exchange_rate,
    p_method, p_payment_type, 'recorded',
    v_paid_at, v_reference, nullif(btrim(coalesce(p_payer_name, '')), ''),
    nullif(btrim(coalesce(p_note, '')), ''),
    p_duplicate_override, p_overpayment_override, nullif(v_reason, ''), v_user
  )
  returning * into v_payment;

  perform public.confirm_on_deposit(p_booking_id);

  return v_payment;
end;
$$;

-- ---------------------------------------------------------------------------
-- verify_payment : somebody with the bank app open says the money is really
-- there. Recording and verifying are deliberately different acts, and the
-- second one is not available to the person who usually does the first.
-- ---------------------------------------------------------------------------
create or replace function public.verify_payment(p_payment_id uuid)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_payment public.payments;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  select * into v_payment from public.payments where id = p_payment_id;
  if v_payment.id is null then
    raise exception 'payment_not_found' using errcode = 'P0002';
  end if;

  if not public.has_business_permission(v_payment.business_id, 'payments.verify') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_payment.status = 'voided' then
    raise exception 'payment_voided' using errcode = '22023';
  end if;

  update public.payments
  set status = 'verified', verified_by = v_user, verified_at = now()
  where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;

-- ---------------------------------------------------------------------------
-- void_payment : this money never arrived.
--
-- The row survives with status 'voided' and stops counting towards the
-- balance; payment_adjustments records who decided that and why. There is no
-- delete, here or anywhere else in this phase.
-- ---------------------------------------------------------------------------
create or replace function public.void_payment(p_payment_id uuid, p_reason text)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_payment public.payments;
  v_reason  text := btrim(coalesce(p_reason, ''));
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  select * into v_payment from public.payments where id = p_payment_id;
  if v_payment.id is null then
    raise exception 'payment_not_found' using errcode = 'P0002';
  end if;

  if not public.has_business_permission(v_payment.business_id, 'payments.void') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if char_length(v_reason) < 3 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  if v_payment.status = 'voided' then
    return v_payment;
  end if;

  insert into public.payment_adjustments (
    business_id, payment_id, action, reason, original_amount, created_by)
  values (v_payment.business_id, v_payment.id, 'void', v_reason, v_payment.amount, v_user);

  update public.payments set status = 'voided' where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;

-- ---------------------------------------------------------------------------
-- correct_payment : the amount, method, date, reference or payer was typed
-- wrong. The old amount is preserved in payment_adjustments before the new one
-- is written, so a correction is always a pair of numbers, never a rewrite.
--
-- A corrected payment drops back to 'recorded': an amount that changed after
-- somebody verified it has not been verified.
-- ---------------------------------------------------------------------------
create or replace function public.correct_payment(
  p_payment_id uuid,
  p_amount     numeric,
  p_reason     text,
  p_method     public.payment_method default null,
  p_paid_at    timestamptz default null,
  p_reference  text default null,
  p_payer_name text default null,
  p_note       text default null
)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_payment  public.payments;
  v_summary  record;
  v_original numeric(12,2);
  v_reason   text := btrim(coalesce(p_reason, ''));
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  select * into v_payment from public.payments where id = p_payment_id;
  if v_payment.id is null then
    raise exception 'payment_not_found' using errcode = 'P0002';
  end if;

  if not public.has_business_permission(v_payment.business_id, 'payments.correct') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if char_length(v_reason) < 3 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if v_payment.status = 'voided' then
    raise exception 'payment_voided' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_payment.booking_id::text, 0));

  v_original := v_payment.amount;

  insert into public.payment_adjustments (
    business_id, payment_id, action, reason, original_amount, corrected_amount, created_by)
  values (v_payment.business_id, v_payment.id, 'correct', v_reason,
          v_original, round(p_amount, 2), v_user);

  update public.payments set
    amount      = round(p_amount, 2),
    method      = coalesce(p_method, method),
    paid_at     = coalesce(p_paid_at, paid_at),
    reference   = coalesce(v_reference, reference),
    payer_name  = coalesce(nullif(btrim(coalesce(p_payer_name, '')), ''), payer_name),
    note        = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note),
    status      = 'recorded',
    verified_by = null,
    verified_at = null
  where id = p_payment_id
  returning * into v_payment;

  -- A correction can carry a booking over its deposit line just as a new
  -- payment can, so the same rule applies afterwards.
  perform public.confirm_on_deposit(v_payment.booking_id);

  select * into v_summary from public.booking_payment_summary(v_payment.booking_id);
  return v_payment;
end;
$$;

-- ---------------------------------------------------------------------------
-- refund_payment : money going back to the guest.
--
-- The refund is its own payment row (type 'refund', positive amount) linked to
-- the original through payment_adjustments. Nothing subtracts from the original
-- row — its history stays readable, and the booking's net_paid falls because a
-- refund row exists, not because a number was edited.
-- ---------------------------------------------------------------------------
create or replace function public.refund_payment(
  p_payment_id uuid,
  p_amount     numeric,
  p_reason     text,
  p_method     public.payment_method default null
)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_payment  public.payments;
  v_refund   public.payments;
  v_refunded numeric(12,2);
  v_timezone text;
  v_reason   text := btrim(coalesce(p_reason, ''));
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  select * into v_payment from public.payments where id = p_payment_id;
  if v_payment.id is null then
    raise exception 'payment_not_found' using errcode = 'P0002';
  end if;

  if not public.has_business_permission(v_payment.business_id, 'payments.refund') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if char_length(v_reason) < 3 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if v_payment.status = 'voided' then
    raise exception 'payment_voided' using errcode = '22023';
  end if;
  if v_payment.payment_type = 'refund' then
    raise exception 'invalid_payment_type' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_payment.booking_id::text, 0));

  -- What has already gone back against this payment, refunds of it excluded if
  -- they were themselves voided.
  select coalesce(sum(r.amount), 0)::numeric(12,2) into v_refunded
  from public.payment_adjustments a
  join public.payments r on r.id = a.refund_payment_id and r.status <> 'voided'
  where a.payment_id = p_payment_id and a.action = 'refund';

  if p_amount is null or p_amount <= 0
     or round(v_refunded + p_amount, 2) > v_payment.amount then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  select timezone into v_timezone from public.business_settings where business_id = v_payment.business_id;

  insert into public.payments (
    business_id, booking_id, customer_id, payment_number,
    amount, currency, exchange_rate, method, payment_type, status,
    paid_at, payer_name, note, created_by
  )
  values (
    v_payment.business_id, v_payment.booking_id, v_payment.customer_id,
    public.next_payment_number(v_payment.business_id, now(), coalesce(v_timezone, 'UTC')),
    round(p_amount, 2), v_payment.currency, v_payment.exchange_rate,
    coalesce(p_method, v_payment.method), 'refund', 'recorded',
    now(), v_payment.payer_name, v_reason, v_user
  )
  returning * into v_refund;

  insert into public.payment_adjustments (
    business_id, payment_id, action, reason,
    original_amount, corrected_amount, refund_payment_id, created_by)
  values (v_payment.business_id, v_payment.id, 'refund', v_reason,
          v_payment.amount, round(p_amount, 2), v_refund.id, v_user);

  if round(v_refunded + p_amount, 2) >= v_payment.amount then
    update public.payments set status = 'refunded' where id = p_payment_id;
  end if;

  return v_refund;
end;
$$;

-- ---------------------------------------------------------------------------
-- issue_receipt : freeze what the booking looks like right now.
--
-- Everything the printed receipt shows is copied into `snapshot`. Renaming the
-- property or fixing a typo in the guest's name next month changes the record;
-- it must not change the piece of paper the guest is already holding.
-- ---------------------------------------------------------------------------
create or replace function public.issue_receipt(
  p_booking_id uuid,
  p_payment_id uuid default null,
  p_language   text default 'en'
)
returns public.receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_booking  public.bookings;
  v_payment  public.payments;
  v_summary  record;
  v_receipt  public.receipts;
  v_snapshot jsonb;
  v_timezone text;
  v_language text := case when lower(coalesce(p_language, 'en')) = 'km' then 'km' else 'en' end;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id;
  if v_booking.id is null then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  if not public.has_business_permission(v_booking.business_id, 'receipts.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_payment_id is not null then
    select * into v_payment from public.payments
    where id = p_payment_id and business_id = v_booking.business_id;
    if v_payment.id is null then
      raise exception 'payment_not_found' using errcode = 'P0002';
    end if;
  end if;

  select * into v_summary from public.booking_payment_summary(p_booking_id);
  select timezone into v_timezone from public.business_settings where business_id = v_booking.business_id;

  select jsonb_build_object(
    'business_name', biz.name,
    'business_phone', biz.phone,
    'booking_number', v_booking.booking_number,
    'customer_name', cust.full_name,
    'customer_phone', cust.phone,
    'property_name', prop.name,
    'check_in_at', v_booking.check_in_at,
    'check_out_at', v_booking.check_out_at,
    'currency', v_booking.currency,
    'booking_total', v_summary.booking_total,
    'deposit_required', v_summary.deposit_required,
    'total_paid', v_summary.total_paid,
    'refund_total', v_summary.refund_total,
    'net_paid', v_summary.net_paid,
    'balance', v_summary.balance,
    'payment_status', v_summary.payment_status,
    'payment_number', v_payment.payment_number,
    'payment_amount', v_payment.amount,
    'payment_method', v_payment.method,
    'payment_reference', v_payment.reference,
    'payment_at', v_payment.paid_at,
    'issued_by_name', coalesce(prof.full_name, ''),
    'timezone', coalesce(v_timezone, 'UTC')
  )
  into v_snapshot
  from public.businesses biz
  join public.customers cust on cust.id = v_booking.customer_id
  join public.properties prop on prop.id = v_booking.property_id
  left join public.profiles prof on prof.id = v_user
  where biz.id = v_booking.business_id;

  insert into public.receipts (
    business_id, booking_id, payment_id, receipt_number, language, snapshot, issued_by)
  values (
    v_booking.business_id, v_booking.id, p_payment_id,
    public.next_receipt_number(v_booking.business_id, now(), coalesce(v_timezone, 'UTC')),
    v_language, v_snapshot, v_user)
  returning * into v_receipt;

  return v_receipt;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. confirm_on_deposit stays internal: it changes a booking's status
-- without asking who is calling.
-- ---------------------------------------------------------------------------
revoke all on function public.confirm_on_deposit(uuid) from public, anon, authenticated;

revoke all on function public.payment_duplicates(uuid, text, numeric, timestamptz, text, uuid) from public;
revoke all on function public.record_payment(uuid, numeric, public.payment_method, public.payment_type, timestamptz, text, text, text, boolean, boolean, text) from public;
revoke all on function public.verify_payment(uuid) from public;
revoke all on function public.void_payment(uuid, text) from public;
revoke all on function public.correct_payment(uuid, numeric, text, public.payment_method, timestamptz, text, text, text) from public;
revoke all on function public.refund_payment(uuid, numeric, text, public.payment_method) from public;
revoke all on function public.issue_receipt(uuid, uuid, text) from public;

grant execute on function public.payment_duplicates(uuid, text, numeric, timestamptz, text, uuid) to authenticated;
grant execute on function public.record_payment(uuid, numeric, public.payment_method, public.payment_type, timestamptz, text, text, text, boolean, boolean, text) to authenticated;
grant execute on function public.verify_payment(uuid) to authenticated;
grant execute on function public.void_payment(uuid, text) to authenticated;
grant execute on function public.correct_payment(uuid, numeric, text, public.payment_method, timestamptz, text, text, text) to authenticated;
grant execute on function public.refund_payment(uuid, numeric, text, public.payment_method) to authenticated;
grant execute on function public.issue_receipt(uuid, uuid, text) to authenticated;
