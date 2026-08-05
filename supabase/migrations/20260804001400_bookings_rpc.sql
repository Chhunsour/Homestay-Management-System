-- =============================================================================
-- Phase 4 RPCs: every write that can create a double-booking.
--
-- The client is never trusted with three things: the price, whether the dates
-- are free, and whether the caller may override either. All three are decided
-- here, inside the transaction, after taking an advisory lock on the property —
-- so two people saving the same dates at the same moment serialise, and the
-- second one sees the first one's booking.
--
-- Errors follow the existing contract: auth_required (28000), forbidden
-- (42501), *_not_found (P0002), validation (22023). booking_conflict uses
-- 23P01 (exclusion_violation) and carries the conflict list in DETAIL.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- booking_conflicts : the single definition of "these dates are taken".
--
-- Ranges are half-open [check_in, check_out), so a booking that ends at the
-- exact minute the next one starts is not a conflict — back-to-back stays are
-- normal. Mirrored by rangesOverlap() in packages/shared/src/availability.ts.
--
-- Internal: the caller is responsible for the permission check.
-- ---------------------------------------------------------------------------
create or replace function public.booking_conflicts(
  p_business_id uuid,
  p_property_id uuid,
  p_check_in    timestamptz,
  p_check_out   timestamptz,
  p_exclude     uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(c order by c->>'starts_at'), '[]'::jsonb)
  from (
    -- The property itself may be the reason it cannot be booked.
    select jsonb_build_object(
             'kind', case when p.archived_at is not null
                          then 'property_archived' else 'property_inactive' end,
             'id', p.id, 'label', p.name,
             'starts_at', null, 'ends_at', null) as c
    from public.properties p
    where p.id = p_property_id
      and p.business_id = p_business_id
      and (p.archived_at is not null or not p.is_active)

    union all

    select jsonb_build_object(
             'kind', 'block', 'id', b.id, 'label', b.reason::text,
             'starts_at', b.starts_at, 'ends_at', b.ends_at)
    from public.property_blocks b
    where b.property_id = p_property_id
      and b.business_id = p_business_id
      and b.status = 'active'
      and tstzrange(b.starts_at, b.ends_at, '[)')
          && tstzrange(p_check_in, p_check_out, '[)')

    union all

    select jsonb_build_object(
             'kind', 'booking', 'id', k.id, 'label', k.booking_number,
             'starts_at', k.check_in_at, 'ends_at', k.check_out_at)
    from public.bookings k
    join public.booking_statuses s on s.id = k.status_id
    where k.property_id = p_property_id
      and k.business_id = p_business_id
      and (p_exclude is null or k.id <> p_exclude)
      -- Cancelled hands the dates back; pending still holds them.
      and s.code in ('pending', 'confirmed', 'completed')
      and tstzrange(k.check_in_at, k.check_out_at, '[)')
          && tstzrange(p_check_in, p_check_out, '[)')
  ) rows;
$$;

comment on function public.booking_conflicts(uuid, uuid, timestamptz, timestamptz, uuid) is
  'Everything standing between these dates and a booking. Half-open ranges: adjacent stays never conflict.';

-- ---------------------------------------------------------------------------
-- check_booking_availability : the same answer, for the form to show before
-- the user hits save. Read-only, so `bookings.manage` is enough.
-- ---------------------------------------------------------------------------
create or replace function public.check_booking_availability(
  p_business_id uuid,
  p_property_id uuid,
  p_check_in    timestamptz,
  p_check_out   timestamptz,
  p_exclude     uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  if not public.has_business_permission(p_business_id, 'bookings.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_check_out <= p_check_in then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  return public.booking_conflicts(
    p_business_id, p_property_id, p_check_in, p_check_out, p_exclude);
end;
$$;

-- ---------------------------------------------------------------------------
-- save_booking : create (p_booking_id null) and edit share one body, because
-- they share every rule — the lock, the conflict scan, the price authority and
-- the status permissions are identical whether the row exists yet or not.
--
-- ponytail: one RPC instead of create_booking + update_booking. The forms post
-- the whole booking either way; splitting it would duplicate ~120 lines of
-- guards for no behavioural difference.
-- ---------------------------------------------------------------------------
create or replace function public.save_booking(
  p_business_id      uuid,
  p_property_id      uuid,
  p_customer_id      uuid,
  p_check_in         timestamptz,
  p_check_out        timestamptz,
  p_booking_id       uuid    default null,
  p_status_id        uuid    default null,
  p_source           text    default 'other',
  p_note             text    default null,
  p_internal_note    text    default null,
  p_final_price      numeric default null,
  p_price_reason     text    default null,
  p_conflict_override boolean default false,
  p_conflict_reason  text    default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user       uuid := auth.uid();
  v_timezone   text;
  v_existing   public.bookings;
  v_new_code   public.booking_status_code;
  v_old_code   public.booking_status_code;
  v_status_id  uuid;
  v_conflicts  jsonb := '[]'::jsonb;
  v_blocking   boolean;
  v_calculated numeric(12,2);
  v_final      numeric(12,2);
  v_overridden boolean := false;
  v_currency   public.app_currency;
  v_override   boolean := false;
  v_booking    public.bookings;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  -- Membership of *this* business, resolved from the token — a forged
  -- p_business_id fails here, it does not select a different tenant.
  if not public.has_business_permission(p_business_id, 'bookings.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_check_out <= p_check_in then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  -- Weekday/weekend is decided in the business's own zone, not the server's.
  select coalesce(timezone, 'Asia/Phnom_Penh') into v_timezone
  from public.business_settings where business_id = p_business_id;
  v_timezone := coalesce(v_timezone, 'Asia/Phnom_Penh');

  if p_booking_id is not null then
    select * into v_existing
    from public.bookings
    where id = p_booking_id and business_id = p_business_id;

    if v_existing.id is null then
      raise exception 'booking_not_found' using errcode = 'P0002';
    end if;
  end if;

  -- Serialise everyone touching this property. Held to the end of the
  -- transaction, so the conflict scan below cannot be raced by a second
  -- request that scanned before this one inserted.
  perform pg_advisory_xact_lock(hashtextextended(p_property_id::text, 0));

  if not exists (select 1 from public.properties
                 where id = p_property_id and business_id = p_business_id) then
    raise exception 'property_not_found' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.customers
                 where id = p_customer_id and business_id = p_business_id) then
    raise exception 'customer_not_found' using errcode = 'P0002';
  end if;

  -- Status: default to the business's system 'pending'.
  v_status_id := coalesce(
    p_status_id,
    (select id from public.booking_statuses
     where business_id = p_business_id and code = 'pending' and is_system
     limit 1));

  select code into v_new_code
  from public.booking_statuses
  where id = v_status_id and business_id = p_business_id and is_active;

  if v_new_code is null then
    raise exception 'status_not_found' using errcode = 'P0002';
  end if;

  if v_existing.id is not null then
    select code into v_old_code
    from public.booking_statuses where id = v_existing.status_id;
  end if;

  -- Cancelling and reopening are separate permissions from editing.
  if v_new_code = 'cancelled' and v_old_code is distinct from 'cancelled'
     and not public.has_business_permission(p_business_id, 'bookings.cancel') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_old_code = 'cancelled' and v_new_code <> 'cancelled'
     and not public.has_business_permission(p_business_id, 'bookings.restore') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_blocking := v_new_code in ('pending', 'confirmed', 'completed');

  -- ---- availability -------------------------------------------------------
  -- A cancelled booking occupies nothing, so nothing can be in its way.
  if v_blocking then
    v_conflicts := public.booking_conflicts(
      p_business_id, p_property_id, p_check_in, p_check_out, p_booking_id);

    -- An archived or switched-off property is not a conflict to be overridden;
    -- it is the wrong property.
    if exists (select 1 from jsonb_array_elements(v_conflicts) c
               where c->>'kind' in ('property_archived', 'property_inactive')) then
      raise exception 'property_unavailable' using errcode = '22023';
    end if;

    if jsonb_array_length(v_conflicts) > 0 then
      if not p_conflict_override then
        raise exception 'booking_conflict'
          using errcode = '23P01', detail = v_conflicts::text;
      end if;

      -- Staff never reach this line: the permission is owner/manager only.
      if not public.has_business_permission(p_business_id, 'bookings.conflict.override') then
        raise exception 'forbidden' using errcode = '42501';
      end if;

      if char_length(btrim(coalesce(p_conflict_reason, ''))) < 3 then
        raise exception 'conflict_reason_required' using errcode = '22023';
      end if;

      v_override := true;
    end if;
  end if;

  -- ---- price --------------------------------------------------------------
  -- Recomputed here from the property's own rate card. Whatever the client
  -- posted as a total is a preview; only p_final_price can change the outcome,
  -- and only with the permission and a reason.
  v_calculated := public.booking_calculated_price(
    p_property_id, p_check_in, p_check_out, v_timezone);

  select currency into v_currency
  from public.property_pricing
  where property_id = p_property_id and rule_type = 'base';

  v_final := v_calculated;

  if p_final_price is not null and p_final_price <> v_calculated then
    if not public.has_business_permission(p_business_id, 'bookings.price.override') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if char_length(btrim(coalesce(p_price_reason, ''))) < 3 then
      raise exception 'price_reason_required' using errcode = '22023';
    end if;
    if p_final_price < 0 then
      raise exception 'invalid_price' using errcode = '22023';
    end if;
    v_final      := p_final_price;
    v_overridden := true;
  end if;

  -- ---- write --------------------------------------------------------------
  if v_existing.id is null then
    insert into public.bookings (
      business_id, booking_number, property_id, customer_id, status_id,
      check_in_at, check_out_at, currency, calculated_price, final_price,
      price_overridden, price_override_reason, source, note, internal_note,
      conflict_override, conflict_override_reason, conflict_override_by,
      conflict_override_at, created_by, updated_by
    )
    values (
      p_business_id,
      public.next_booking_number(p_business_id, p_check_in, v_timezone),
      p_property_id, p_customer_id, v_status_id,
      p_check_in, p_check_out, v_currency, v_calculated, v_final,
      v_overridden, case when v_overridden then btrim(p_price_reason) end,
      coalesce(nullif(btrim(p_source), ''), 'other'),
      nullif(btrim(coalesce(p_note, '')), ''),
      nullif(btrim(coalesce(p_internal_note, '')), ''),
      v_override, case when v_override then btrim(p_conflict_reason) end,
      case when v_override then v_user end,
      case when v_override then now() end,
      v_user, v_user
    )
    returning * into v_booking;
  else
    update public.bookings set
      property_id      = p_property_id,
      customer_id      = p_customer_id,
      status_id        = v_status_id,
      check_in_at      = p_check_in,
      check_out_at     = p_check_out,
      currency         = v_currency,
      -- Re-quoted because the dates or the property may have moved. The old
      -- quote belonged to the old dates; it is not history worth keeping.
      calculated_price = v_calculated,
      final_price      = v_final,
      price_overridden = v_overridden,
      price_override_reason = case when v_overridden then btrim(p_price_reason) end,
      source           = coalesce(nullif(btrim(p_source), ''), 'other'),
      note             = nullif(btrim(coalesce(p_note, '')), ''),
      internal_note    = nullif(btrim(coalesce(p_internal_note, '')), ''),
      conflict_override        = v_override,
      conflict_override_reason = case when v_override then btrim(p_conflict_reason) end,
      conflict_override_by     = case when v_override then v_user end,
      conflict_override_at     = case when v_override then now() end,
      updated_by       = v_user
    where id = v_existing.id
    returning * into v_booking;
  end if;

  return v_booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_booking_status : the one-tap status change from the list and detail
-- screens. Reopening a cancelled booking re-runs the conflict scan, because
-- the dates may well have been given to someone else in the meantime.
-- ---------------------------------------------------------------------------
create or replace function public.set_booking_status(
  p_booking_id       uuid,
  p_status_id        uuid,
  p_conflict_override boolean default false,
  p_conflict_reason  text    default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user      uuid := auth.uid();
  v_booking   public.bookings;
  v_new_code  public.booking_status_code;
  v_old_code  public.booking_status_code;
  v_conflicts jsonb;
  v_override  boolean := false;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id;

  if v_booking.id is null then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  if not public.has_business_permission(v_booking.business_id, 'bookings.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select code into v_new_code
  from public.booking_statuses
  where id = p_status_id and business_id = v_booking.business_id and is_active;

  if v_new_code is null then
    raise exception 'status_not_found' using errcode = 'P0002';
  end if;

  select code into v_old_code
  from public.booking_statuses where id = v_booking.status_id;

  if v_new_code = 'cancelled' and v_old_code is distinct from 'cancelled'
     and not public.has_business_permission(v_booking.business_id, 'bookings.cancel') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_old_code = 'cancelled' and v_new_code <> 'cancelled'
     and not public.has_business_permission(v_booking.business_id, 'bookings.restore') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Only a move back into a blocking status can create a conflict.
  if v_new_code in ('pending', 'confirmed', 'completed')
     and v_old_code not in ('pending', 'confirmed', 'completed') then
    perform pg_advisory_xact_lock(hashtextextended(v_booking.property_id::text, 0));

    v_conflicts := public.booking_conflicts(
      v_booking.business_id, v_booking.property_id,
      v_booking.check_in_at, v_booking.check_out_at, v_booking.id);

    if jsonb_array_length(v_conflicts) > 0 then
      if not p_conflict_override then
        raise exception 'booking_conflict'
          using errcode = '23P01', detail = v_conflicts::text;
      end if;
      if not public.has_business_permission(v_booking.business_id, 'bookings.conflict.override') then
        raise exception 'forbidden' using errcode = '42501';
      end if;
      if char_length(btrim(coalesce(p_conflict_reason, ''))) < 3 then
        raise exception 'conflict_reason_required' using errcode = '22023';
      end if;
      v_override := true;
    end if;
  end if;

  update public.bookings set
    status_id  = p_status_id,
    updated_by = v_user,
    conflict_override        = case when v_override then true else conflict_override end,
    conflict_override_reason = case when v_override then btrim(p_conflict_reason) else conflict_override_reason end,
    conflict_override_by     = case when v_override then v_user else conflict_override_by end,
    conflict_override_at     = case when v_override then now() else conflict_override_at end
  where id = p_booking_id
  returning * into v_booking;

  return v_booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- resolve_pending_booking : what to do with a hold that ran out.
--
-- Expiry never releases dates on its own — someone decides. 'keep' stamps
-- pending_resolved_at so the booking stops appearing in the review list while
-- staying pending; 'release' cancels it, which is what hands the dates back.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_pending_booking(
  p_booking_id uuid,
  p_action     text
)
returns public.bookings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_booking public.bookings;
  v_cancel  uuid;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  if p_action not in ('keep', 'release') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id;

  if v_booking.id is null then
    raise exception 'booking_not_found' using errcode = 'P0002';
  end if;

  if not public.has_business_permission(v_booking.business_id, 'bookings.pending.resolve') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_action = 'keep' then
    update public.bookings
    set pending_resolved_at = now(), updated_by = v_user
    where id = p_booking_id
    returning * into v_booking;
  else
    select id into v_cancel
    from public.booking_statuses
    where business_id = v_booking.business_id and code = 'cancelled' and is_system
    limit 1;

    -- The status trigger clears the hold columns and stamps cancelled_at.
    update public.bookings
    set status_id = v_cancel, updated_by = v_user
    where id = p_booking_id
    returning * into v_booking;
  end if;

  return v_booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. booking_conflicts stays internal — it answers questions about a
-- property id without checking who is asking.
-- ---------------------------------------------------------------------------
revoke all on function public.booking_conflicts(uuid, uuid, timestamptz, timestamptz, uuid)
  from public, anon, authenticated;
revoke all on function public.check_booking_availability(uuid, uuid, timestamptz, timestamptz, uuid) from public;
revoke all on function public.save_booking(uuid, uuid, uuid, timestamptz, timestamptz, uuid, uuid, text, text, text, numeric, text, boolean, text) from public;
revoke all on function public.set_booking_status(uuid, uuid, boolean, text) from public;
revoke all on function public.resolve_pending_booking(uuid, text) from public;

grant execute on function public.check_booking_availability(uuid, uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.save_booking(uuid, uuid, uuid, timestamptz, timestamptz, uuid, uuid, text, text, text, numeric, text, boolean, text) to authenticated;
grant execute on function public.set_booking_status(uuid, uuid, boolean, text) to authenticated;
grant execute on function public.resolve_pending_booking(uuid, text) to authenticated;
