-- =============================================================================
-- Phase 2 authorisation: new permissions + RLS on every property table.
--
-- Rules encoded here:
--   * Owner   — everything, including archiving a property.
--   * Manager — create, edit, activate/deactivate, price, photos, blocks.
--   * Staff   — read properties, pricing, photos and blocks. Nothing else.
--   * Archiving is not reachable through UPDATE; it is an RPC (next migration).
--   * No table grants DELETE on properties at all.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permission matrix additions. `properties.manage` already exists from Phase 1
-- (owner + manager) and keeps its meaning: create and edit a property.
-- Mirrored by packages/shared/src/roles.ts; roles.test.ts fails if they drift.
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role, permission) values
  -- read: every active member, staff included
  ('owner',   'properties.read'),
  ('manager', 'properties.read'),
  ('staff',   'properties.read'),
  -- pricing, photos and blocks: owner + manager only
  ('owner',   'properties.pricing.manage'),
  ('manager', 'properties.pricing.manage'),
  ('owner',   'properties.photos.manage'),
  ('manager', 'properties.photos.manage'),
  ('owner',   'properties.blocks.manage'),
  ('manager', 'properties.blocks.manage'),
  -- archiving ("delete"): owner only
  ('owner',   'properties.archive')
on conflict (role, permission) do nothing;

-- ---------------------------------------------------------------------------
-- RLS + privileges. As in Phase 1: revoke everything, then grant only what a
-- policy could ever allow. No DELETE on properties — archive instead.
-- ---------------------------------------------------------------------------
alter table public.properties       enable row level security;
alter table public.property_photos  enable row level security;
alter table public.property_pricing enable row level security;
alter table public.property_blocks  enable row level security;

revoke all on public.properties, public.property_photos,
              public.property_pricing, public.property_blocks
  from anon, authenticated;

grant select, insert, update         on public.properties       to authenticated;
grant select, insert, update, delete on public.property_photos  to authenticated;
grant select, insert, update         on public.property_pricing to authenticated;
grant select, insert, update         on public.property_blocks  to authenticated;

-- ---------------------------------------------------------------------------
-- properties
--
-- business_id arrives from the client on INSERT. `has_business_permission`
-- resolves the caller's role from auth.uid() for exactly that business, so a
-- forged id buys nothing: the caller is simply not a member of it.
-- ---------------------------------------------------------------------------
drop policy if exists properties_select on public.properties;
create policy properties_select
  on public.properties for select to authenticated
  using (archived_at is null and public.has_business_permission(business_id, 'properties.read'));

drop policy if exists properties_insert on public.properties;
create policy properties_insert
  on public.properties for insert to authenticated
  with check (
    archived_at is null
    and public.has_business_permission(business_id, 'properties.manage')
    -- created_by is an audit column; it may only ever be the caller.
    and (created_by is null or created_by = auth.uid())
  );

-- WITH CHECK repeats `archived_at is null`, so archiving cannot be done here —
-- set_property_archived() is the only path, and it needs properties.archive.
drop policy if exists properties_update on public.properties;
create policy properties_update
  on public.properties for update to authenticated
  using (archived_at is null and public.has_business_permission(business_id, 'properties.manage'))
  with check (archived_at is null and public.has_business_permission(business_id, 'properties.manage'));

-- ---------------------------------------------------------------------------
-- property_photos — authorisation inherited from the property through the
-- composite FK: (property_id, business_id) must exist in properties, so a photo
-- can never be attached to another tenant's property.
-- ---------------------------------------------------------------------------
drop policy if exists property_photos_select on public.property_photos;
create policy property_photos_select
  on public.property_photos for select to authenticated
  using (public.has_business_permission(business_id, 'properties.read'));

drop policy if exists property_photos_insert on public.property_photos;
create policy property_photos_insert
  on public.property_photos for insert to authenticated
  with check (
    public.has_business_permission(business_id, 'properties.photos.manage')
    and (created_by is null or created_by = auth.uid())
    -- The row must describe an object inside this tenant's own storage prefix.
    and storage_path like 'businesses/' || business_id::text || '/properties/' || property_id::text || '/%'
  );

drop policy if exists property_photos_update on public.property_photos;
create policy property_photos_update
  on public.property_photos for update to authenticated
  using (public.has_business_permission(business_id, 'properties.photos.manage'))
  with check (public.has_business_permission(business_id, 'properties.photos.manage'));

-- Photos are the one thing that really is deleted: the storage object goes with
-- it, and there is no history worth keeping in a thumbnail.
drop policy if exists property_photos_delete on public.property_photos;
create policy property_photos_delete
  on public.property_photos for delete to authenticated
  using (public.has_business_permission(business_id, 'properties.photos.manage'));

-- ---------------------------------------------------------------------------
-- property_pricing
-- ---------------------------------------------------------------------------
drop policy if exists property_pricing_select on public.property_pricing;
create policy property_pricing_select
  on public.property_pricing for select to authenticated
  using (public.has_business_permission(business_id, 'properties.read'));

drop policy if exists property_pricing_insert on public.property_pricing;
create policy property_pricing_insert
  on public.property_pricing for insert to authenticated
  with check (public.has_business_permission(business_id, 'properties.pricing.manage'));

drop policy if exists property_pricing_update on public.property_pricing;
create policy property_pricing_update
  on public.property_pricing for update to authenticated
  using (public.has_business_permission(business_id, 'properties.pricing.manage'))
  with check (public.has_business_permission(business_id, 'properties.pricing.manage'));

-- ---------------------------------------------------------------------------
-- property_blocks. There is no DELETE grant: a block is cancelled, not erased,
-- so "why was this property unavailable in March" stays answerable.
-- ---------------------------------------------------------------------------
drop policy if exists property_blocks_select on public.property_blocks;
create policy property_blocks_select
  on public.property_blocks for select to authenticated
  using (public.has_business_permission(business_id, 'properties.read'));

drop policy if exists property_blocks_insert on public.property_blocks;
create policy property_blocks_insert
  on public.property_blocks for insert to authenticated
  with check (
    public.has_business_permission(business_id, 'properties.blocks.manage')
    -- created_by is an audit column; it may only ever be the caller.
    and (created_by is null or created_by = auth.uid())
  );

drop policy if exists property_blocks_update on public.property_blocks;
create policy property_blocks_update
  on public.property_blocks for update to authenticated
  using (public.has_business_permission(business_id, 'properties.blocks.manage'))
  with check (public.has_business_permission(business_id, 'properties.blocks.manage'));
