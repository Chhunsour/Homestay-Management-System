-- =============================================================================
-- Phase 3 schema: customers and internal customer notes.
--
-- Customers never sign in — there is no auth.users row behind them. They are
-- records owned by a business, so every table is tenant-scoped by business_id
-- and gets RLS in the next migration.
--
-- Phone is the identity. The number is stored twice: `phone` exactly as it was
-- typed (for display and for dialling) and `normalized_phone` in E.164 (the
-- only column duplicate detection and phone search compare). The normaliser is
-- packages/shared/src/phone.ts; this file only enforces the resulting shape.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- normalize_phone : the SQL twin of packages/shared/src/phone.ts.
--
-- It exists so no client ever supplies `normalized_phone`. A caller that could
-- send its own value could hide a customer from duplicate detection simply by
-- getting it wrong. supabase/tests/rls_customers.sql asserts the two
-- implementations agree on the same table of inputs the unit tests use.
-- ---------------------------------------------------------------------------
create or replace function public.normalize_phone(p_input text)
returns text
language plpgsql
immutable
as $$
declare
  v_cleaned  text;
  v_digits   text;
  v_intl     boolean;
  v_national text;
begin
  if p_input is null then
    return null;
  end if;

  -- Spaces, dashes, dots, parentheses and slashes are formatting, never data.
  v_cleaned := regexp_replace(p_input, '[^0-9+]', '', 'g');
  v_digits  := replace(v_cleaned, '+', '');
  if v_digits = '' then
    return null;
  end if;

  -- `+` and the `00` trunk prefix both mean "a country code follows".
  v_intl := left(v_cleaned, 1) = '+';
  if left(v_digits, 2) = '00' then
    v_digits := substr(v_digits, 3);
    v_intl   := true;
  end if;
  if v_digits = '' then
    return null;
  end if;

  if v_intl then
    if left(v_digits, 3) = '855' then
      v_national := ltrim(substr(v_digits, 4), '0');
      return case when v_national = '' then null else '+855' || v_national end;
    end if;
    -- A genuine foreign number, kept as dialled.
    return '+' || v_digits;
  end if;

  -- No prefix at all: `85512345678` pasted from a chat app is still Cambodian,
  -- but `0855…` is not, so the length of what follows has to make sense first.
  if left(v_digits, 3) = '855'
     and length(ltrim(substr(v_digits, 4), '0')) between 8 and 9 then
    return '+855' || ltrim(substr(v_digits, 4), '0');
  end if;

  v_national := ltrim(v_digits, '0');
  return case when v_national = '' then null else '+855' || v_national end;
end;
$$;

comment on function public.normalize_phone(text) is
  'E.164 normalisation, Cambodia first. Mirrors packages/shared/src/phone.ts.';

-- ---------------------------------------------------------------------------
-- customers. Archived, never hard deleted: Phase 4 bookings and Phase 5
-- payments will reference these rows.
-- ---------------------------------------------------------------------------
create table if not exists public.customers (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses (id) on delete cascade,
  full_name          text not null check (char_length(btrim(full_name)) between 2 and 160),

  phone              text not null check (char_length(btrim(phone)) between 5 and 32),
  -- E.164. A row that reaches the table with a malformed normalised number
  -- would be invisible to duplicate detection, so the shape is a constraint
  -- rather than a convention.
  normalized_phone   text not null check (normalized_phone ~ '^\+[1-9][0-9]{7,14}$'),
  phone_secondary    text check (phone_secondary is null
                       or char_length(btrim(phone_secondary)) between 5 and 32),
  normalized_phone_secondary text check (normalized_phone_secondary is null
                       or normalized_phone_secondary ~ '^\+[1-9][0-9]{7,14}$'),

  email              text check (email is null or char_length(email) between 3 and 320),
  facebook_name      text check (facebook_name is null or char_length(btrim(facebook_name)) <= 160),
  facebook_url       text check (facebook_url is null or char_length(btrim(facebook_url)) <= 500),
  telegram_username  text check (telegram_username is null
                       or telegram_username ~ '^[A-Za-z0-9_]{3,32}$'),

  preferred_language public.app_locale not null default 'en',
  address            text check (address is null or char_length(btrim(address)) <= 500),
  note               text check (note is null or char_length(note) <= 2000),

  archived_at        timestamptz,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Lets customer_notes carry business_id and have the database guarantee it
  -- matches the parent, so the note policies can trust the column.
  constraint customers_id_business_key unique (id, business_id)
);

comment on table public.customers is
  'Guest record owned by a business. Guests never authenticate; created_by is the staff member.';
comment on column public.customers.phone is
  'As typed, for display. Never used for matching — normalized_phone is.';
comment on column public.customers.normalized_phone is
  'E.164 from packages/shared/src/phone.ts. Tenant-unique among live customers.';
comment on column public.customers.archived_at is
  'Soft delete. Set only through set_customer_archived(); the UPDATE policy forbids it.';

-- One live customer per phone per business. Two businesses may of course hold
-- the same guest, and an archived row does not block re-creating the number.
create unique index if not exists customers_business_phone_key
  on public.customers (business_id, normalized_phone)
  where archived_at is null;

-- Duplicate detection reads archived rows too, so this one is not partial:
-- the answer to "do we already know this number" includes "yes, archived".
create index if not exists customers_phone_lookup_idx
  on public.customers (business_id, normalized_phone);

create index if not exists customers_business_recent_idx
  on public.customers (business_id, created_at desc);
create index if not exists customers_business_name_idx
  on public.customers (business_id, lower(full_name));
create index if not exists customers_created_by_idx
  on public.customers (created_by);

-- ---------------------------------------------------------------------------
-- customer_notes : internal staff commentary. Never exposed publicly, and no
-- public-facing surface reads this table at all.
-- ---------------------------------------------------------------------------
create table if not exists public.customer_notes (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  customer_id uuid not null,
  body        text not null check (char_length(btrim(body)) between 2 and 2000),
  archived_at timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint customer_notes_customer_fkey
    foreign key (customer_id, business_id)
    references public.customers (id, business_id) on delete cascade
);

comment on table public.customer_notes is
  'Internal notes. Staff-only; nothing guest-facing may ever select from here.';
comment on constraint customer_notes_customer_fkey on public.customer_notes is
  'Composite FK: business_id cannot drift from the customer it belongs to.';

create index if not exists customer_notes_customer_idx
  on public.customer_notes (customer_id, created_at desc)
  where archived_at is null;

-- ---------------------------------------------------------------------------
-- Normalisation is a trigger, not a client responsibility. Both phone columns
-- are derived from what was typed on every insert and every update, so a
-- forged normalised value is impossible rather than merely discouraged.
-- ---------------------------------------------------------------------------
create or replace function public.set_customer_normalized_phone()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.phone := btrim(new.phone);
  new.normalized_phone := public.normalize_phone(new.phone);
  new.phone_secondary := nullif(btrim(coalesce(new.phone_secondary, '')), '');
  new.normalized_phone_secondary := public.normalize_phone(new.phone_secondary);

  if new.normalized_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists set_normalized_phone on public.customers;
create trigger set_normalized_phone
  before insert or update of phone, phone_secondary on public.customers
  for each row execute function public.set_customer_normalized_phone();

-- ---------------------------------------------------------------------------
-- updated_at triggers, reusing the Phase 1 function
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['customers', 'customer_notes']
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end
$$;
