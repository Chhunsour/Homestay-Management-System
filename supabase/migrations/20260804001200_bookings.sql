-- =============================================================================
-- Phase 4 schema: booking statuses, bookings, status history.
--
-- A booking reserves one whole property for a half-open range
-- [check_in_at, check_out_at) — the same convention property_blocks uses, so a
-- stay ending at 12:00 and one starting at 12:00 are neighbours, not a clash.
--
-- Two things are deliberately *not* here:
--   * no room-level inventory — a property is rented complete;
--   * no payment, receipt or balance column — that is Phase 5.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The internal status vocabulary. Display names live in booking_statuses.name
-- and are the owner's to change; every rule in this system is written against
-- these four codes instead, so renaming "Pending" to "Reserved" breaks nothing.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'booking_status_code') then
    create type public.booking_status_code as enum
      ('pending', 'confirmed', 'completed', 'cancelled');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- booking_statuses — per business, seeded on creation, editable afterwards.
-- ---------------------------------------------------------------------------
create table if not exists public.booking_statuses (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name        text not null,
  code        public.booking_status_code not null,
  color       text not null default '#334155',
  sort_order  integer not null default 0,
  -- One row per code per business, created with the business. Cannot be
  -- deleted or have its code changed; can be renamed, recoloured, reordered.
  is_system   boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint booking_statuses_id_business_key unique (id, business_id),
  constraint booking_statuses_name_check
    check (char_length(btrim(name)) between 2 and 40),
  constraint booking_statuses_color_check
    check (color ~ '^#[0-9a-fA-F]{6}$'),
  constraint booking_statuses_sort_check
    check (sort_order between 0 and 999)
);

-- Names are compared case-insensitively: "Pending" and "pending" are one label.
create unique index if not exists booking_statuses_name_key
  on public.booking_statuses (business_id, lower(btrim(name)));

-- Exactly one built-in status per code per business — what the seed relies on,
-- and what findStatusByCode() in the shared package expects to find.
create unique index if not exists booking_statuses_system_key
  on public.booking_statuses (business_id, code)
  where is_system;

create index if not exists booking_statuses_business_idx
  on public.booking_statuses (business_id, sort_order);

-- ---------------------------------------------------------------------------
-- booking_counters — the source of human-readable booking numbers.
--
-- One row per (business, year). `on conflict do update` takes a row lock, so
-- two concurrent requests queue instead of racing to the same number. Scoped
-- per business, so BK-2026-000001 says nothing about anyone else's volume.
--
-- No grants and no policies: only the SECURITY DEFINER RPC touches this.
-- ---------------------------------------------------------------------------
create table if not exists public.booking_counters (
  business_id uuid not null references public.businesses (id) on delete cascade,
  year        integer not null,
  last_number bigint not null default 0,
  primary key (business_id, year)
);

-- ---------------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------------
create table if not exists public.bookings (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses (id) on delete cascade,
  booking_number text not null,

  property_id uuid not null,
  customer_id uuid not null,
  status_id   uuid not null,

  check_in_at  timestamptz not null,
  check_out_at timestamptz not null,

  currency         public.app_currency not null,
  -- What the property's rates said at the time. Never recomputed afterwards:
  -- raising a rate in June must not rewrite what May's guests were quoted.
  calculated_price numeric(12,2) not null,
  -- What is actually owed. Equal to calculated_price unless overridden.
  final_price      numeric(12,2) not null,
  price_overridden boolean not null default false,
  price_override_reason text,
  -- Only filled when the booking currency differs from the business default;
  -- Phase 5 reads it instead of guessing a historical rate.
  exchange_rate    numeric(14,6),

  source        text not null default 'other',
  note          text,
  internal_note text,

  -- Pending hold. Set while the status code is 'pending', cleared otherwise.
  pending_expires_at  timestamptz,
  -- An owner/manager saw the expired hold and chose to keep the booking.
  pending_resolved_at timestamptz,

  conflict_override        boolean not null default false,
  conflict_override_reason text,
  conflict_override_by     uuid references auth.users (id) on delete set null,
  conflict_override_at     timestamptz,

  cancelled_at timestamptz,
  created_by   uuid references auth.users (id) on delete set null,
  updated_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint bookings_id_business_key unique (id, business_id),
  constraint bookings_number_key unique (business_id, booking_number),
  constraint bookings_number_check check (booking_number ~ '^BK-[0-9]{4}-[0-9]{6}$'),

  -- Checkout must come after check-in. A stay of zero length is not a stay.
  constraint bookings_range_check check (check_out_at > check_in_at),

  constraint bookings_price_check
    check (calculated_price >= 0 and final_price >= 0),
  -- An overridden price without a reason is a number nobody can audit later.
  constraint bookings_price_override_check
    check (not price_overridden or char_length(btrim(coalesce(price_override_reason, ''))) >= 3),
  constraint bookings_exchange_rate_check
    check (exchange_rate is null or exchange_rate > 0),

  constraint bookings_source_check
    check (source in ('facebook', 'telegram', 'phone', 'walk_in', 'website', 'other')),
  constraint bookings_note_check
    check (note is null or char_length(note) <= 2000),
  constraint bookings_internal_note_check
    check (internal_note is null or char_length(internal_note) <= 2000),

  -- Same rule for the conflict override, plus who approved it and when.
  constraint bookings_conflict_check
    check (
      not conflict_override
      or (
        char_length(btrim(coalesce(conflict_override_reason, ''))) >= 3
        and conflict_override_by is not null
        and conflict_override_at is not null
      )
    ),

  -- The composite FKs are the tenant guarantee: a booking cannot point at
  -- another business's property, customer or status, whatever a client sends.
  constraint bookings_property_fkey foreign key (property_id, business_id)
    references public.properties (id, business_id) on delete restrict,
  constraint bookings_customer_fkey foreign key (customer_id, business_id)
    references public.customers (id, business_id) on delete restrict,
  constraint bookings_status_fkey foreign key (status_id, business_id)
    references public.booking_statuses (id, business_id) on delete restrict
);

-- Overlap search: "what else is on this property around these dates".
create index if not exists bookings_property_range_idx
  on public.bookings (property_id, check_in_at, check_out_at);

create index if not exists bookings_business_checkin_idx
  on public.bookings (business_id, check_in_at desc);

create index if not exists bookings_customer_idx on public.bookings (customer_id);
create index if not exists bookings_status_idx   on public.bookings (status_id);
create index if not exists bookings_number_idx   on public.bookings (business_id, booking_number);

-- The expired-holds review list, straight off an index.
create index if not exists bookings_pending_idx
  on public.bookings (business_id, pending_expires_at)
  where pending_expires_at is not null and pending_resolved_at is null;

-- ---------------------------------------------------------------------------
-- booking_status_history — written by a trigger, never by a client.
-- Answers "who cancelled this, and when" without a full audit-log table.
-- ---------------------------------------------------------------------------
create table if not exists public.booking_status_history (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses (id) on delete cascade,
  booking_id     uuid not null,
  from_status_id uuid,
  to_status_id   uuid not null,
  changed_by     uuid references auth.users (id) on delete set null,
  changed_at     timestamptz not null default now(),

  constraint booking_status_history_booking_fkey foreign key (booking_id, business_id)
    references public.bookings (id, business_id) on delete cascade
);

create index if not exists booking_status_history_booking_idx
  on public.booking_status_history (booking_id, changed_at desc);

-- ---------------------------------------------------------------------------
-- Seed: every business gets the four built-in statuses the moment it exists.
-- A trigger rather than an edit to create_business(), so any path that creates
-- a business — RPC, restore, fixture — ends up with a usable status list.
-- Mirrors DEFAULT_BOOKING_STATUSES in packages/shared/src/constants.ts.
-- ---------------------------------------------------------------------------
create or replace function public.seed_booking_statuses()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.booking_statuses (business_id, name, code, color, sort_order, is_system)
  values
    (new.id, 'Pending',   'pending',   '#b45309', 1, true),
    (new.id, 'Confirmed', 'confirmed', '#0f766e', 2, true),
    (new.id, 'Completed', 'completed', '#334155', 3, true),
    (new.id, 'Cancelled', 'cancelled', '#b91c1c', 4, true)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists businesses_seed_booking_statuses on public.businesses;
create trigger businesses_seed_booking_statuses
  after insert on public.businesses
  for each row execute function public.seed_booking_statuses();

-- Businesses that already exist (Phases 1–3 data) get theirs now.
insert into public.booking_statuses (business_id, name, code, color, sort_order, is_system)
select b.id, s.name, s.code, s.color, s.sort_order, true
from public.businesses b
cross join (values
  ('Pending',   'pending'::public.booking_status_code,   '#b45309', 1),
  ('Confirmed', 'confirmed'::public.booking_status_code, '#0f766e', 2),
  ('Completed', 'completed'::public.booking_status_code, '#334155', 3),
  ('Cancelled', 'cancelled'::public.booking_status_code, '#b91c1c', 4)
) as s(name, code, color, sort_order)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- A built-in status keeps its code and cannot be removed. Renaming,
-- recolouring, reordering and hiding stay allowed.
-- ---------------------------------------------------------------------------
create or replace function public.guard_system_booking_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'system_status' using errcode = '42501';
    end if;
    return old;
  end if;

  if old.is_system and (new.code is distinct from old.code or new.is_system = false) then
    raise exception 'system_status' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists booking_statuses_guard on public.booking_statuses;
create trigger booking_statuses_guard
  before update or delete on public.booking_statuses
  for each row execute function public.guard_system_booking_status();

-- ---------------------------------------------------------------------------
-- Pending hold, cancellation stamp and the status-change log.
--
-- Derived here rather than in the RPCs so they are true no matter which path
-- wrote the row — including a direct UPDATE through RLS.
-- ---------------------------------------------------------------------------
create or replace function public.apply_booking_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_code      public.booking_status_code;
  v_old_code  public.booking_status_code;
  v_cancelled timestamptz;
begin
  select code into v_code from public.booking_statuses where id = new.status_id;

  if tg_op = 'UPDATE' then
    v_cancelled := old.cancelled_at;
    if new.status_id is distinct from old.status_id then
      select code into v_old_code from public.booking_statuses where id = old.status_id;
    else
      v_old_code := v_code;
    end if;
  end if;

  if v_code = 'pending' then
    -- Being created pending, or entering pending, starts a fresh hold.
    if v_old_code is distinct from 'pending' then
      new.pending_expires_at  := now() + interval '30 minutes';
      new.pending_resolved_at := null;
    end if;
  else
    new.pending_expires_at  := null;
    new.pending_resolved_at := null;
  end if;

  if v_code = 'cancelled' then
    new.cancelled_at := coalesce(v_cancelled, now());
  else
    new.cancelled_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_apply_status on public.bookings;
create trigger bookings_apply_status
  before insert or update on public.bookings
  for each row execute function public.apply_booking_status();

create or replace function public.log_booking_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from uuid;
begin
  if tg_op = 'UPDATE' then
    if new.status_id is not distinct from old.status_id then
      return new;
    end if;
    v_from := old.status_id;
  end if;

  insert into public.booking_status_history
    (business_id, booking_id, from_status_id, to_status_id, changed_by)
  values (
    new.business_id,
    new.id,
    v_from,
    new.status_id,
    coalesce(new.updated_by, new.created_by, auth.uid())
  );
  return new;
end;
$$;

drop trigger if exists bookings_log_status on public.bookings;
create trigger bookings_log_status
  after insert or update of status_id on public.bookings
  for each row execute function public.log_booking_status();

-- updated_at, same helper as every other table.
do $$
declare
  t text;
begin
  foreach t in array array['booking_statuses', 'bookings'] loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- booking_calculated_price : the SQL twin of priceBooking() in the shared
-- package. Weekday rate Monday–Thursday, weekend rate Friday–Sunday, counted
-- in the business's own time zone.
--
-- The server computes this itself instead of storing whatever the client sent:
-- a price is a trust boundary, and staff may not override one.
-- ---------------------------------------------------------------------------
create or replace function public.booking_calculated_price(
  p_property_id uuid,
  p_check_in    timestamptz,
  p_check_out   timestamptz,
  p_timezone    text
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_weekday numeric(12,2);
  v_weekend numeric(12,2);
  v_start   date;
  v_end     date;
  v_days    integer;
  v_total   numeric(12,2);
begin
  select weekday_price, weekend_price into v_weekday, v_weekend
  from public.property_pricing
  where property_id = p_property_id and rule_type = 'base';

  if v_weekday is null then
    raise exception 'pricing_not_found' using errcode = 'P0002';
  end if;

  v_start := (p_check_in  at time zone p_timezone)::date;
  v_end   := (p_check_out at time zone p_timezone)::date;
  -- A same-day stay still costs one day.
  v_days  := greatest(1, v_end - v_start);

  select sum(
    -- isodow: Monday = 1 … Sunday = 7. Friday, Saturday, Sunday are weekend,
    -- matching WEEKEND_DAYS in packages/shared/src/constants.ts.
    case when extract(isodow from v_start + offset_days) in (5, 6, 7)
         then v_weekend else v_weekday end
  )
  into v_total
  from generate_series(0, v_days - 1) as offset_days;

  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- next_booking_number : BK-<year>-<six digits>, unique inside one business.
-- The upsert locks the counter row, so simultaneous callers serialise.
-- ---------------------------------------------------------------------------
create or replace function public.next_booking_number(
  p_business_id uuid,
  p_at          timestamptz,
  p_timezone    text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_year integer := extract(year from (p_at at time zone p_timezone))::integer;
  v_seq  bigint;
begin
  insert into public.booking_counters (business_id, year, last_number)
  values (p_business_id, v_year, 1)
  on conflict (business_id, year)
  do update set last_number = public.booking_counters.last_number + 1
  returning last_number into v_seq;

  return format('BK-%s-%s', v_year, lpad(v_seq::text, 6, '0'));
end;
$$;
