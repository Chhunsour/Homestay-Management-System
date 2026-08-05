-- =============================================================================
-- Phase 2 storage: the private `property-photos` bucket and its RLS.
--
-- Object key layout, enforced by both the bucket policies and the
-- property_photos INSERT policy:
--
--   businesses/{businessId}/properties/{propertyId}/{fileName}
--
-- storage.foldername() splits that into {businesses, businessId, properties,
-- propertyId}, so element 2 is the tenant. Same has_business_permission()
-- check as every other table — one permission matrix, not two.
--
-- The whole migration is guarded on the storage schema existing, because the
-- SQL test harness (supabase/tests/auth_stub.sql) runs on bare postgres with
-- no Storage API.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Path → permission. Used by all four object policies.
-- A malformed key simply fails the regex and returns false rather than raising.
-- ---------------------------------------------------------------------------
create or replace function public.can_access_property_object(
  p_name       text,
  p_permission text
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_name ~ '^businesses/[0-9a-fA-F-]{36}/properties/[0-9a-fA-F-]{36}/.+$'
      then public.has_business_permission(split_part(p_name, '/', 2)::uuid, p_permission)
    else false
  end;
$$;

comment on function public.can_access_property_object(text, text) is
  'Tenant check for storage.objects keys under businesses/{id}/properties/{id}/.';

revoke all on function public.can_access_property_object(text, text) from public;
grant execute on function public.can_access_property_object(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Bucket + object policies
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'storage schema absent (bare postgres) - skipping bucket setup';
    return;
  end if;

  -- private: no public read. Files are served through short-lived signed URLs.
  -- MIME and size are enforced by Storage itself, so a forged client cannot
  -- push a 200 MB executable past a check that only lives in the app.
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'property-photos', 'property-photos', false, 10485760,
    array['image/jpeg', 'image/png', 'image/webp']
  )
  on conflict (id) do update
    set public            = excluded.public,
        file_size_limit   = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute $p$drop policy if exists property_photos_object_select on storage.objects$p$;
  execute $p$
    create policy property_photos_object_select
      on storage.objects for select to authenticated
      using (
        bucket_id = 'property-photos'
        and public.can_access_property_object(name, 'properties.read')
      )
  $p$;

  execute $p$drop policy if exists property_photos_object_insert on storage.objects$p$;
  execute $p$
    create policy property_photos_object_insert
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'property-photos'
        and public.can_access_property_object(name, 'properties.photos.manage')
      )
  $p$;

  execute $p$drop policy if exists property_photos_object_update on storage.objects$p$;
  execute $p$
    create policy property_photos_object_update
      on storage.objects for update to authenticated
      using (
        bucket_id = 'property-photos'
        and public.can_access_property_object(name, 'properties.photos.manage')
      )
      with check (
        bucket_id = 'property-photos'
        and public.can_access_property_object(name, 'properties.photos.manage')
      )
  $p$;

  execute $p$drop policy if exists property_photos_object_delete on storage.objects$p$;
  execute $p$
    create policy property_photos_object_delete
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'property-photos'
        and public.can_access_property_object(name, 'properties.photos.manage')
      )
  $p$;
end
$$;
