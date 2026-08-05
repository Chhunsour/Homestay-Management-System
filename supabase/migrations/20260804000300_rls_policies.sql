-- =============================================================================
-- Row Level Security.
--
-- Rules encoded here:
--   * A user only ever sees rows for businesses where they are an ACTIVE member.
--   * business_members has NO write policy at all: role changes and removals go
--     exclusively through the RPCs in the next migration, so a client cannot
--     insert itself as an owner or promote itself.
--   * businesses has no INSERT policy: creation goes through create_business().
--   * Soft delete cannot be performed from the client (WITH CHECK forbids it).
-- =============================================================================

alter table public.profiles          enable row level security;
alter table public.businesses        enable row level security;
alter table public.business_members  enable row level security;
alter table public.business_settings enable row level security;
alter table public.user_preferences  enable row level security;
alter table public.role_permissions  enable row level security;

-- ---------------------------------------------------------------------------
-- Table privileges. RLS narrows these further; anon gets nothing.
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;

revoke all on public.profiles, public.businesses, public.business_members,
              public.business_settings, public.user_preferences,
              public.role_permissions
  from anon, authenticated;

grant select, insert, update on public.profiles          to authenticated;
grant select, update         on public.businesses        to authenticated;
grant select                 on public.business_members  to authenticated;
grant select, update         on public.business_settings to authenticated;
grant select, insert, update on public.user_preferences  to authenticated;
grant select                 on public.role_permissions  to authenticated;

-- ---------------------------------------------------------------------------
-- role_permissions : readable reference data, never writable from a client
-- ---------------------------------------------------------------------------
drop policy if exists role_permissions_read on public.role_permissions;
create policy role_permissions_read
  on public.role_permissions for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.can_read_member_profile(id));

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
  on public.profiles for insert to authenticated
  with check (id = auth.uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- businesses
-- ---------------------------------------------------------------------------
drop policy if exists businesses_select_members on public.businesses;
create policy businesses_select_members
  on public.businesses for select to authenticated
  using (deleted_at is null and public.is_business_member(id));

-- Owners only (business.update is not granted to manager or staff).
-- WITH CHECK repeats `deleted_at is null` so soft delete cannot be done here.
drop policy if exists businesses_update_privileged on public.businesses;
create policy businesses_update_privileged
  on public.businesses for update to authenticated
  using (deleted_at is null and public.has_business_permission(id, 'business.update'))
  with check (deleted_at is null and public.has_business_permission(id, 'business.update'));

-- ---------------------------------------------------------------------------
-- business_members : read-only from the client
-- ---------------------------------------------------------------------------
drop policy if exists business_members_select on public.business_members;
create policy business_members_select
  on public.business_members for select to authenticated
  using (
    user_id = auth.uid()
    or (
      status = 'active'
      and public.has_business_permission(business_id, 'members.read')
    )
  );

-- ---------------------------------------------------------------------------
-- business_settings
-- ---------------------------------------------------------------------------
drop policy if exists business_settings_select on public.business_settings;
create policy business_settings_select
  on public.business_settings for select to authenticated
  using (public.is_business_member(business_id));

drop policy if exists business_settings_update on public.business_settings;
create policy business_settings_update
  on public.business_settings for update to authenticated
  using (public.has_business_permission(business_id, 'business.settings.manage'))
  with check (public.has_business_permission(business_id, 'business.settings.manage'));

-- ---------------------------------------------------------------------------
-- user_preferences : strictly self, and last_business_id must be a real
-- membership so a client-supplied business id cannot be parked here.
-- ---------------------------------------------------------------------------
drop policy if exists user_preferences_select_self on public.user_preferences;
create policy user_preferences_select_self
  on public.user_preferences for select to authenticated
  using (user_id = auth.uid());

drop policy if exists user_preferences_insert_self on public.user_preferences;
create policy user_preferences_insert_self
  on public.user_preferences for insert to authenticated
  with check (
    user_id = auth.uid()
    and (last_business_id is null or public.is_business_member(last_business_id))
  );

drop policy if exists user_preferences_update_self on public.user_preferences;
create policy user_preferences_update_self
  on public.user_preferences for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (last_business_id is null or public.is_business_member(last_business_id))
  );
