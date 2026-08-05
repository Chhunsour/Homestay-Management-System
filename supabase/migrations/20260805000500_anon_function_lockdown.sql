-- =============================================================================
-- Anonymous callers get nothing in public.
--
-- Supabase's stock default privileges grant EXECUTE on every new function in
-- public to anon, authenticated and service_role at creation time, so the
-- per-function `revoke all ... from public` in the earlier migrations never
-- removed anon's own grant. Nothing in this schema is meant to run before
-- sign-in: the RPCs all raise auth_required, but the pure helpers
-- (normalize_phone, can_access_*_object, the number generators) would happily
-- answer an unauthenticated request. This closes that.
--
-- ponytail: a sweep, not a per-function list — a new function must be granted
-- to authenticated deliberately, which is the direction the mistake should go.
-- =============================================================================

do $$
declare
  v_function text;
begin
  for v_function in
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from anon', v_function);
  end loop;
end;
$$;

-- Future functions in public start with no anon grant at all.
alter default privileges in schema public revoke execute on functions from anon;
