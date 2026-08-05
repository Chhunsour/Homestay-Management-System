-- =============================================================================
-- Phase 2 RPCs: the multi-step property operations.
--
-- As in Phase 1, every function re-derives the caller's role from the database
-- with has_business_permission(). SECURITY DEFINER bypasses RLS, so each one
-- performs that check itself rather than relying on a policy.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- create_property : the property and its base price row are one unit — a
-- property with no rate is not something the app should ever be able to store.
-- ---------------------------------------------------------------------------
create or replace function public.create_property(
  p_business_id    uuid,
  p_name           text,
  p_weekday_price  numeric,
  p_weekend_price  numeric,
  p_currency       public.app_currency default null,
  p_address        text    default null,
  p_description    text    default null,
  p_phone          text    default null,
  p_map_location   text    default null,
  p_latitude       numeric default null,
  p_longitude      numeric default null,
  p_check_in_time  time    default '14:00',
  p_check_out_time time    default '12:00',
  p_is_active      boolean default true
)
returns public.properties
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_currency public.app_currency;
  v_property public.properties;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  if not public.has_business_permission(p_business_id, 'properties.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'property_name_required' using errcode = '22023';
  end if;

  if p_weekday_price is null or p_weekend_price is null
     or p_weekday_price < 0 or p_weekend_price < 0 then
    raise exception 'invalid_price' using errcode = '22023';
  end if;

  -- Fall back to the business default rather than making the client pick.
  v_currency := coalesce(
    p_currency,
    (select s.default_currency from public.business_settings s
      where s.business_id = p_business_id),
    'USD'::public.app_currency
  );

  insert into public.properties (
    business_id, name, address, description, phone, map_location,
    latitude, longitude, default_check_in_time, default_check_out_time,
    is_active, created_by
  )
  values (
    p_business_id,
    btrim(p_name),
    nullif(btrim(coalesce(p_address, '')), ''),
    nullif(btrim(coalesce(p_description, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), ''),
    nullif(btrim(coalesce(p_map_location, '')), ''),
    p_latitude,
    p_longitude,
    coalesce(p_check_in_time, '14:00'::time),
    coalesce(p_check_out_time, '12:00'::time),
    coalesce(p_is_active, true),
    v_user
  )
  returning * into v_property;

  insert into public.property_pricing (
    business_id, property_id, rule_type, weekday_price, weekend_price, currency
  )
  values (p_business_id, v_property.id, 'base', p_weekday_price, p_weekend_price, v_currency);

  return v_property;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_property_archived : the "delete" button. Owners only. Archiving is
-- deliberately unreachable through the UPDATE policy, so this is the one path.
-- ---------------------------------------------------------------------------
create or replace function public.set_property_archived(
  p_property_id uuid,
  p_archived    boolean default true
)
returns public.properties
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business uuid;
  v_property public.properties;
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  select business_id into v_business
  from public.properties
  where id = p_property_id;

  if v_business is null then
    raise exception 'property_not_found' using errcode = 'P0002';
  end if;

  -- Checked after the lookup, but the lookup leaks nothing: an id the caller
  -- guessed still ends in `forbidden`, identical to one that does not exist.
  if not public.has_business_permission(v_business, 'properties.archive') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.properties
  set archived_at = case when p_archived then now() else null end,
      -- An archived property must not come back silently bookable.
      is_active   = case when p_archived then false else is_active end
  where id = p_property_id
  returning * into v_property;

  return v_property;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_property_cover_photo : one cover per property is a partial unique index,
-- so the old cover has to be cleared and the new one set in the same statement
-- pair. Doing it client-side would trip the index halfway through.
-- ---------------------------------------------------------------------------
create or replace function public.set_property_cover_photo(p_photo_id uuid)
returns public.property_photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_photo public.property_photos;
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  select * into v_photo from public.property_photos where id = p_photo_id;
  if not found then
    raise exception 'photo_not_found' using errcode = 'P0002';
  end if;

  if not public.has_business_permission(v_photo.business_id, 'properties.photos.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.property_photos
  set is_cover = false
  where property_id = v_photo.property_id and is_cover and id <> p_photo_id;

  update public.property_photos
  set is_cover = true
  where id = p_photo_id
  returning * into v_photo;

  return v_photo;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.create_property(
  uuid, text, numeric, numeric, public.app_currency, text, text, text, text,
  numeric, numeric, time, time, boolean) from public;
revoke all on function public.set_property_archived(uuid, boolean) from public;
revoke all on function public.set_property_cover_photo(uuid) from public;

grant execute on function public.create_property(
  uuid, text, numeric, numeric, public.app_currency, text, text, text, text,
  numeric, numeric, time, time, boolean) to authenticated;
grant execute on function public.set_property_archived(uuid, boolean) to authenticated;
grant execute on function public.set_property_cover_photo(uuid) to authenticated;
