-- =============================================================================
-- Phase 1 core schema: profiles, businesses, members, settings, preferences.
-- Every tenant table is keyed by business_id and gets RLS in a later migration.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Enumerated domains
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'business_role') then
    create type public.business_role as enum ('owner', 'manager', 'staff');
  end if;
  if not exists (select 1 from pg_type where typname = 'member_status') then
    create type public.member_status as enum ('active', 'suspended');
  end if;
  if not exists (select 1 from pg_type where typname = 'app_locale') then
    create type public.app_locale as enum ('en', 'km');
  end if;
  if not exists (select 1 from pg_type where typname = 'app_currency') then
    create type public.app_currency as enum ('USD', 'KHR');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Reusable updated-at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Generic BEFORE UPDATE trigger that stamps updated_at. Attach to every table.';

-- ---------------------------------------------------------------------------
-- profiles : 1:1 with auth.users
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text        check (full_name is null or char_length(btrim(full_name)) between 1 and 120),
  phone       text        check (phone is null or char_length(btrim(phone)) between 5 and 32),
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is 'Public profile data for an authenticated user.';

-- ---------------------------------------------------------------------------
-- businesses : the tenant root. Soft-deleted so member history survives.
-- ---------------------------------------------------------------------------
create table if not exists public.businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null check (char_length(btrim(name)) between 2 and 120),
  owner_name  text        check (owner_name is null or char_length(btrim(owner_name)) between 1 and 120),
  phone       text        check (phone is null or char_length(btrim(phone)) between 5 and 32),
  created_by  uuid        references auth.users (id) on delete set null,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on column public.businesses.created_by is
  'Audit only. Authorisation always comes from business_members, never from this column.';

create index if not exists businesses_created_by_idx
  on public.businesses (created_by);
create index if not exists businesses_active_idx
  on public.businesses (id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- business_members : the authorisation table
-- ---------------------------------------------------------------------------
create table if not exists public.business_members (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid        not null references public.businesses (id) on delete cascade,
  -- References profiles, not auth.users: profiles.id IS the auth user id, so the
  -- cascade is unchanged, but PostgREST can only embed profiles(...) in a member
  -- query if a foreign key connects the two tables.
  user_id     uuid        not null references public.profiles (id) on delete cascade,
  role        public.business_role  not null,
  status      public.member_status  not null default 'active',
  invited_by  uuid        references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint business_members_unique_membership unique (business_id, user_id)
);

comment on table public.business_members is
  'Single source of truth for "who may touch which business, and how".';

create index if not exists business_members_user_active_idx
  on public.business_members (user_id) where status = 'active';
create index if not exists business_members_business_active_idx
  on public.business_members (business_id, role) where status = 'active';

-- ---------------------------------------------------------------------------
-- business_settings : 1:1 with businesses
-- ---------------------------------------------------------------------------
create table if not exists public.business_settings (
  business_id      uuid primary key references public.businesses (id) on delete cascade,
  default_language public.app_locale   not null default 'en',
  default_currency public.app_currency not null default 'USD',
  timezone         text                not null default 'Asia/Phnom_Penh'
                     check (char_length(timezone) between 1 and 64),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- user_preferences : per-user, cross-business
-- ---------------------------------------------------------------------------
create table if not exists public.user_preferences (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  language         public.app_locale not null default 'en',
  last_business_id uuid references public.businesses (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists user_preferences_last_business_idx
  on public.user_preferences (last_business_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'businesses', 'business_members', 'business_settings', 'user_preferences'
  ]
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Provision profile + preferences whenever a user signs up (any provider)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_language public.app_locale := 'en';
  v_meta_language text := new.raw_user_meta_data ->> 'language';
begin
  if v_meta_language in ('en', 'km') then
    v_language := v_meta_language::public.app_locale;
  end if;

  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    nullif(btrim(coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      ''
    )), ''),
    nullif(btrim(coalesce(new.phone, '')), '')
  )
  on conflict (id) do nothing;

  insert into public.user_preferences (user_id, language)
  values (new.id, v_language)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
