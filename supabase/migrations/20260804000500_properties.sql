-- =============================================================================
-- Phase 2 schema: properties, photos, pricing and manual availability blocks.
--
-- A booking (Phase 4) will reserve a whole property, so there is deliberately
-- no room-level inventory here. Every table is tenant-scoped by business_id and
-- gets RLS in the next migration.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Enumerated domains
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'block_reason') then
    create type public.block_reason as enum ('maintenance', 'owner_use', 'renovation', 'custom');
  end if;
  if not exists (select 1 from pg_type where typname = 'block_status') then
    create type public.block_status as enum ('active', 'cancelled');
  end if;
  -- Discriminator on property_pricing. 'base' is the only rule Phase 2 needs;
  -- seasonal / event rules are added as new enum values plus a date range,
  -- without touching the property model. See docs/PHASE_2_PROPERTIES.md.
  if not exists (select 1 from pg_type where typname = 'pricing_rule_type') then
    create type public.pricing_rule_type as enum ('base');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- properties : one row per rentable building. Archived, never hard deleted,
-- because Phase 4 bookings will reference it.
-- ---------------------------------------------------------------------------
create table if not exists public.properties (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete cascade,
  name                   text not null check (char_length(btrim(name)) between 2 and 120),
  address                text check (address is null or char_length(btrim(address)) <= 500),
  description            text check (description is null or char_length(description) <= 4000),
  phone                  text check (phone is null or char_length(btrim(phone)) between 5 and 32),
  -- Free-text landmark / map link. Coordinates below are the machine-readable form.
  map_location           text check (map_location is null or char_length(btrim(map_location)) <= 500),
  latitude               numeric(9, 6)  check (latitude is null or latitude between -90 and 90),
  longitude              numeric(9, 6)  check (longitude is null or longitude between -180 and 180),
  default_check_in_time  time not null default '14:00',
  default_check_out_time time not null default '12:00',
  is_active              boolean not null default true,
  archived_at            timestamptz,
  created_by             uuid references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- Lets every child table carry business_id and have the database guarantee it
  -- matches the parent, so a policy can trust the column instead of joining.
  constraint properties_id_business_key unique (id, business_id)
);

comment on table public.properties is
  'Entire-property rental unit. Archived (archived_at) rather than deleted.';
comment on column public.properties.is_active is
  'Operator toggle: an inactive property is unavailable but still visible.';
comment on column public.properties.archived_at is
  'Soft delete. Set only through set_property_archived(); the UPDATE policy forbids it.';

-- Two live properties in one business may not share a name; archived ones may.
create unique index if not exists properties_business_name_key
  on public.properties (business_id, lower(btrim(name)))
  where archived_at is null;

create index if not exists properties_business_live_idx
  on public.properties (business_id, is_active)
  where archived_at is null;
create index if not exists properties_created_by_idx
  on public.properties (created_by);

-- ---------------------------------------------------------------------------
-- property_photos : metadata only. The bytes live in the private
-- `property-photos` storage bucket, keyed by storage_path.
-- ---------------------------------------------------------------------------
create table if not exists public.property_photos (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null,
  property_id  uuid not null,
  storage_path text not null unique
                 check (char_length(storage_path) between 1 and 1024),
  file_name    text check (file_name is null or char_length(file_name) <= 255),
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes   integer check (size_bytes is null or size_bytes between 1 and 10485760),
  is_cover     boolean not null default false,
  sort_order   integer not null default 0,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint property_photos_property_fkey
    foreign key (property_id, business_id)
    references public.properties (id, business_id) on delete cascade
);

comment on constraint property_photos_property_fkey on public.property_photos is
  'Composite FK: business_id cannot drift from the property it belongs to.';

create unique index if not exists property_photos_single_cover_key
  on public.property_photos (property_id)
  where is_cover;

create index if not exists property_photos_property_idx
  on public.property_photos (property_id, sort_order, created_at);

-- ---------------------------------------------------------------------------
-- property_pricing : rates, normalised out of the property so additional rule
-- types can be added later without changing properties.
-- ---------------------------------------------------------------------------
create table if not exists public.property_pricing (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null,
  property_id   uuid not null,
  rule_type     public.pricing_rule_type not null default 'base',
  -- Weekend = Friday, Saturday, Sunday. Encoded once in
  -- packages/shared/src/availability.ts, not repeated per row.
  weekday_price numeric(12, 2) not null check (weekday_price >= 0),
  weekend_price numeric(12, 2) not null check (weekend_price >= 0),
  currency      public.app_currency not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint property_pricing_property_fkey
    foreign key (property_id, business_id)
    references public.properties (id, business_id) on delete cascade
);

comment on table public.property_pricing is
  'One base rule per property today. Seasonal rules become extra rows with a new rule_type.';

create unique index if not exists property_pricing_base_key
  on public.property_pricing (property_id)
  where rule_type = 'base';

-- ---------------------------------------------------------------------------
-- property_blocks : manual unavailability (maintenance, owner use, renovation).
-- Cancelled rather than deleted so the reason stays auditable.
-- ---------------------------------------------------------------------------
create table if not exists public.property_blocks (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  property_id uuid not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      public.block_reason not null,
  note        text check (note is null or char_length(note) <= 1000),
  status      public.block_status not null default 'active',
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Half-open range [starts_at, ends_at): an end before or equal to the start
  -- is not a block, it is a bug.
  constraint property_blocks_range_check check (ends_at > starts_at),
  constraint property_blocks_property_fkey
    foreign key (property_id, business_id)
    references public.properties (id, business_id) on delete cascade
);

comment on column public.property_blocks.status is
  'Cancelled blocks stay for audit. Availability only considers status = active.';

create index if not exists property_blocks_active_idx
  on public.property_blocks (property_id, starts_at, ends_at)
  where status = 'active';
create index if not exists property_blocks_business_idx
  on public.property_blocks (business_id, starts_at);

-- ---------------------------------------------------------------------------
-- updated_at triggers, reusing the Phase 1 function
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'properties', 'property_photos', 'property_pricing', 'property_blocks'
  ]
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end
$$;
