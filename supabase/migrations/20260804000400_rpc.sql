-- =============================================================================
-- Trusted multi-step operations.
--
-- Every function re-derives the caller's role from the database. Nothing here
-- trusts a role, business id or user id supplied by the client beyond using it
-- as a lookup key.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- create_business : business + owner membership + settings + preferences,
-- atomically. The caller's role is hard-coded to 'owner'; there is no
-- parameter through which a client could ask for something else.
-- ---------------------------------------------------------------------------
create or replace function public.create_business(
  p_name       text,
  p_owner_name text,
  p_phone      text,
  p_language   public.app_locale   default 'en',
  p_currency   public.app_currency default 'USD',
  p_timezone   text                default 'Asia/Phnom_Penh'
)
returns public.businesses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_business public.businesses;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'business_name_required' using errcode = '22023';
  end if;

  -- Validate against the server's own tz database rather than an app-side list.
  if p_timezone is null
     or not exists (select 1 from pg_timezone_names z where z.name = p_timezone) then
    raise exception 'invalid_timezone' using errcode = '22023';
  end if;

  insert into public.businesses (name, owner_name, phone, created_by)
  values (
    btrim(p_name),
    nullif(btrim(coalesce(p_owner_name, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), ''),
    v_user
  )
  returning * into v_business;

  insert into public.business_members (business_id, user_id, role, status)
  values (v_business.id, v_user, 'owner', 'active');

  insert into public.business_settings (business_id, default_language, default_currency, timezone)
  values (v_business.id, p_language, p_currency, p_timezone);

  insert into public.profiles (id, full_name, phone)
  values (v_user, nullif(btrim(coalesce(p_owner_name, '')), ''), nullif(btrim(coalesce(p_phone, '')), ''))
  on conflict (id) do update
    set full_name = coalesce(excluded.full_name, public.profiles.full_name),
        phone     = coalesce(excluded.phone, public.profiles.phone);

  insert into public.user_preferences (user_id, language, last_business_id)
  values (v_user, p_language, v_business.id)
  on conflict (user_id) do update
    set language         = excluded.language,
        last_business_id = excluded.last_business_id;

  return v_business;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_member_role : owners only, never on yourself, never orphan a business.
-- ---------------------------------------------------------------------------
create or replace function public.set_member_role(
  p_business_id uuid,
  p_user_id     uuid,
  p_role        public.business_role
)
returns public.business_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_actor_role  public.business_role;
  v_target      public.business_members;
  v_owner_count integer;
begin
  if v_actor is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  -- No self-service promotion, demotion or role edit of any kind.
  if p_user_id = v_actor then
    raise exception 'cannot_modify_own_role' using errcode = '42501';
  end if;

  v_actor_role := public.current_role_in(p_business_id);
  if v_actor_role is distinct from 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_target
  from public.business_members
  where business_id = p_business_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;

  -- Never leave a business without an owner. Counts *other* active owners so a
  -- suspended owner can still be demoted.
  if v_target.role = 'owner' and p_role <> 'owner' then
    select count(*) into v_owner_count
    from public.business_members
    where business_id = p_business_id
      and role = 'owner' and status = 'active'
      and user_id <> p_user_id;
    if v_owner_count < 1 then
      raise exception 'last_owner' using errcode = '42501';
    end if;
  end if;

  update public.business_members
  set role = p_role
  where id = v_target.id
  returning * into v_target;

  return v_target;
end;
$$;

-- ---------------------------------------------------------------------------
-- remove_member : owners may remove anyone but the last owner; managers may
-- only remove staff. Nobody removes themselves through this path.
-- ---------------------------------------------------------------------------
create or replace function public.remove_member(
  p_business_id uuid,
  p_user_id     uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_actor_role  public.business_role;
  v_target      public.business_members;
  v_owner_count integer;
begin
  if v_actor is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  if p_user_id = v_actor then
    raise exception 'cannot_remove_self' using errcode = '42501';
  end if;

  v_actor_role := public.current_role_in(p_business_id);
  if not public.has_business_permission(p_business_id, 'members.remove') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_target
  from public.business_members
  where business_id = p_business_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;

  -- Only owners may remove an owner or a manager.
  if v_actor_role <> 'owner' and v_target.role in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_target.role = 'owner' then
    select count(*) into v_owner_count
    from public.business_members
    where business_id = p_business_id
      and role = 'owner' and status = 'active'
      and user_id <> p_user_id;
    if v_owner_count < 1 then
      raise exception 'last_owner' using errcode = '42501';
    end if;
  end if;

  delete from public.business_members where id = v_target.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- soft_delete_business : owners only. The RLS UPDATE policy deliberately
-- cannot set deleted_at, so this is the single path.
-- ---------------------------------------------------------------------------
create or replace function public.soft_delete_business(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  if not public.has_business_permission(p_business_id, 'business.delete') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.businesses
  set deleted_at = now()
  where id = p_business_id and deleted_at is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.create_business(text, text, text, public.app_locale, public.app_currency, text) from public;
revoke all on function public.set_member_role(uuid, uuid, public.business_role) from public;
revoke all on function public.remove_member(uuid, uuid) from public;
revoke all on function public.soft_delete_business(uuid) from public;

grant execute on function public.create_business(text, text, text, public.app_locale, public.app_currency, text) to authenticated;
grant execute on function public.set_member_role(uuid, uuid, public.business_role) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.soft_delete_business(uuid) to authenticated;
