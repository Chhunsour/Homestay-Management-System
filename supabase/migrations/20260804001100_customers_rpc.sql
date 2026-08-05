-- =============================================================================
-- Phase 3 RPCs: the customer operations that need more than a row policy.
--
-- As in Phases 1 and 2, every function re-derives the caller's role from the
-- database with has_business_permission(). SECURITY DEFINER bypasses RLS, so
-- each one performs that check itself rather than relying on a policy.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- set_customer_archived : the "delete" button, and its undo. Archiving is
-- deliberately unreachable through the UPDATE policy, so this is the one path.
-- ---------------------------------------------------------------------------
create or replace function public.set_customer_archived(
  p_customer_id uuid,
  p_archived    boolean default true
)
returns public.customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business uuid;
  v_customer public.customers;
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  select business_id into v_business
  from public.customers
  where id = p_customer_id;

  if v_business is null then
    raise exception 'customer_not_found' using errcode = 'P0002';
  end if;

  -- Checked after the lookup, but the lookup leaks nothing: an id the caller
  -- guessed still ends in `forbidden`, identical to one that does not exist.
  if not public.has_business_permission(v_business, 'customers.archive') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.customers
  set archived_at = case when p_archived then now() else null end
  where id = p_customer_id
  returning * into v_customer;

  return v_customer;
end;
$$;

-- ---------------------------------------------------------------------------
-- import_customers : one CSV import, one transaction, one result per row.
--
-- The permission lives here rather than in the UI because a bulk import is a
-- different act from typing in a walk-in guest: staff may do the second and
-- not the first. Every row reports its own outcome — there is no path where a
-- row is dropped without the caller being told which one and why.
-- ---------------------------------------------------------------------------
create or replace function public.import_customers(
  p_business_id uuid,
  p_rows        jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_row     jsonb;
  v_index   integer := 0;
  v_id      uuid;
  v_results jsonb := '[]'::jsonb;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  if not public.has_business_permission(p_business_id, 'customers.import') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'invalid_rows' using errcode = '22023';
  end if;

  if jsonb_array_length(p_rows) > 500 then
    raise exception 'too_many_rows' using errcode = '22023';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      insert into public.customers (
        business_id, full_name, phone, email, facebook_name,
        telegram_username, address, note, preferred_language, created_by
      )
      values (
        p_business_id,
        btrim(coalesce(v_row->>'full_name', '')),
        btrim(coalesce(v_row->>'phone', '')),
        nullif(btrim(lower(coalesce(v_row->>'email', ''))), ''),
        nullif(btrim(coalesce(v_row->>'facebook_name', '')), ''),
        nullif(btrim(coalesce(v_row->>'telegram_username', '')), ''),
        nullif(btrim(coalesce(v_row->>'address', '')), ''),
        nullif(btrim(coalesce(v_row->>'note', '')), ''),
        coalesce(nullif(v_row->>'preferred_language', ''), 'en')::public.app_locale,
        v_user
      )
      returning id into v_id;

      v_results := v_results || jsonb_build_object(
        'index', v_index, 'status', 'imported', 'customer_id', v_id, 'message', null);
    exception
      when unique_violation then
        v_results := v_results || jsonb_build_object(
          'index', v_index, 'status', 'duplicate', 'customer_id', null, 'message', null);
      when others then
        v_results := v_results || jsonb_build_object(
          'index', v_index, 'status', 'invalid', 'customer_id', null, 'message', sqlerrm);
    end;
    v_index := v_index + 1;
  end loop;

  return v_results;
end;
$$;

-- ---------------------------------------------------------------------------
-- export_customers : the bulk read staff are not allowed to perform.
--
-- Reading one customer at a time is `customers.manage`; taking the whole list
-- away is `customers.export`. Enforcing that in SQL means hiding the button is
-- not the control — calling this directly with a staff token returns 42501.
-- ---------------------------------------------------------------------------
create or replace function public.export_customers(
  p_business_id uuid,
  p_archived    boolean default false,
  p_search      text default null
)
returns setof public.customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  if not public.has_business_permission(p_business_id, 'customers.export') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select c.*
  from public.customers c
  where c.business_id = p_business_id
    -- p_archived null means "both", matching the list's All filter.
    and (p_archived is null
         or (p_archived and c.archived_at is not null)
         or (not p_archived and c.archived_at is null))
    and (
      p_search is null or btrim(p_search) = ''
      or c.full_name         ilike '%' || btrim(p_search) || '%'
      or c.phone             ilike '%' || btrim(p_search) || '%'
      or c.normalized_phone  ilike '%' || coalesce(public.normalize_phone(p_search), btrim(p_search)) || '%'
      or coalesce(c.facebook_name, '')     ilike '%' || btrim(p_search) || '%'
      or coalesce(c.telegram_username, '') ilike '%' || btrim(p_search) || '%'
      or coalesce(c.email, '')             ilike '%' || btrim(p_search) || '%'
    )
  order by c.full_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.set_customer_archived(uuid, boolean) from public;
revoke all on function public.import_customers(uuid, jsonb) from public;
revoke all on function public.export_customers(uuid, boolean, text) from public;
revoke all on function public.normalize_phone(text) from public;

grant execute on function public.set_customer_archived(uuid, boolean) to authenticated;
grant execute on function public.import_customers(uuid, jsonb) to authenticated;
grant execute on function public.export_customers(uuid, boolean, text) to authenticated;
grant execute on function public.normalize_phone(text) to authenticated;
