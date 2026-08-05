-- =============================================================================
-- Central permission model + the SECURITY DEFINER helpers used by every policy.
--
-- These helpers are the reason the RLS policies do not recurse: a policy on
-- business_members cannot itself SELECT business_members, but a definer
-- function owned by the table owner can.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permission matrix. Mirrored by packages/shared/src/roles.ts (the UI copy);
-- packages/shared/src/roles.test.ts fails if the two drift.
-- ---------------------------------------------------------------------------
create table if not exists public.role_permissions (
  role       public.business_role not null,
  permission text not null check (char_length(permission) between 3 and 64),
  primary key (role, permission)
);

comment on table public.role_permissions is
  'Server-side permission matrix. Enforcement point for RLS and RPCs.';

-- Rewritten wholesale so re-running the migration converges on this exact set.
delete from public.role_permissions;
insert into public.role_permissions (role, permission) values
  -- owner: full business access
  ('owner', 'business.update'),
  ('owner', 'business.delete'),
  ('owner', 'business.settings.manage'),
  ('owner', 'subscription.manage'),
  ('owner', 'platform.settings.manage'),
  ('owner', 'members.read'),
  ('owner', 'members.invite'),
  ('owner', 'members.role.update'),
  ('owner', 'members.remove'),
  ('owner', 'properties.manage'),
  ('owner', 'customers.manage'),
  ('owner', 'bookings.manage'),
  ('owner', 'payments.manage'),
  -- manager: properties, customers, bookings, payments + read/invite team
  ('manager', 'members.read'),
  ('manager', 'members.invite'),
  ('manager', 'members.remove'),
  ('manager', 'properties.manage'),
  ('manager', 'customers.manage'),
  ('manager', 'bookings.manage'),
  ('manager', 'payments.manage'),
  -- staff: operational only
  ('staff', 'customers.manage'),
  ('staff', 'bookings.manage');

-- ---------------------------------------------------------------------------
-- Helpers. All are STABLE + SECURITY DEFINER with a pinned search_path so a
-- caller cannot shadow `public` and hijack the lookup.
-- ---------------------------------------------------------------------------

-- Role of the *calling* user in a business, or NULL. Deliberately has no
-- user_id parameter: callers may only ask about themselves.
create or replace function public.current_role_in(p_business_id uuid)
returns public.business_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select bm.role
  from public.business_members bm
  join public.businesses b on b.id = bm.business_id
  where bm.business_id = p_business_id
    and bm.user_id = auth.uid()
    and bm.status = 'active'
    and b.deleted_at is null
  limit 1;
$$;

create or replace function public.is_business_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.current_role_in(p_business_id) is not null;
$$;

create or replace function public.has_business_permission(
  p_business_id uuid,
  p_permission  text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.role_permissions rp
    where rp.role = public.current_role_in(p_business_id)
      and rp.permission = p_permission
  );
$$;

comment on function public.has_business_permission(uuid, text) is
  'The only authorisation predicate policies should use. Never trusts client input.';

-- Owners and managers may read the profiles of their active co-members.
create or replace function public.can_read_member_profile(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.business_members me
    join public.business_members them
      on them.business_id = me.business_id
    join public.businesses b
      on b.id = me.business_id and b.deleted_at is null
    where me.user_id = auth.uid()
      and me.status = 'active'
      and me.role in ('owner', 'manager')
      and them.user_id = p_user_id
      and them.status = 'active'
  );
$$;

-- Resolves "the business this user should see right now": their most recently
-- selected one, else their oldest membership.
create or replace function public.current_business_context()
returns table (
  business_id      uuid,
  business_name    text,
  role             public.business_role,
  default_currency public.app_currency,
  default_language public.app_locale,
  timezone         text,
  member_count     bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with picked as (
    select bm.business_id, bm.role
    from public.business_members bm
    join public.businesses b
      on b.id = bm.business_id and b.deleted_at is null
    left join public.user_preferences up
      on up.user_id = bm.user_id
    where bm.user_id = auth.uid()
      and bm.status = 'active'
    order by (bm.business_id is not distinct from up.last_business_id) desc,
             bm.created_at asc
    limit 1
  )
  select
    b.id,
    b.name,
    picked.role,
    coalesce(s.default_currency, 'USD'::public.app_currency),
    coalesce(s.default_language, 'en'::public.app_locale),
    coalesce(s.timezone, 'Asia/Phnom_Penh'),
    (select count(*) from public.business_members m
      where m.business_id = b.id and m.status = 'active')
  from picked
  join public.businesses b on b.id = picked.business_id
  left join public.business_settings s on s.business_id = b.id;
$$;

-- ---------------------------------------------------------------------------
-- Grants: helpers are callable by signed-in users only.
-- ---------------------------------------------------------------------------
revoke all on function public.current_role_in(uuid) from public;
revoke all on function public.is_business_member(uuid) from public;
revoke all on function public.has_business_permission(uuid, text) from public;
revoke all on function public.can_read_member_profile(uuid) from public;
revoke all on function public.current_business_context() from public;

grant execute on function public.current_role_in(uuid) to authenticated, service_role;
grant execute on function public.is_business_member(uuid) to authenticated, service_role;
grant execute on function public.has_business_permission(uuid, text) to authenticated, service_role;
grant execute on function public.can_read_member_profile(uuid) to authenticated, service_role;
grant execute on function public.current_business_context() to authenticated, service_role;
