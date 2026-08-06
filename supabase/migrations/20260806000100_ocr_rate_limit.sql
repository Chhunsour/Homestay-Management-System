-- =============================================================================
-- Phase 6A: OCR request throttling.
--
-- The edge function calls an external OCR provider on the caller's behalf, so
-- it needs its own usage protection — a compromised or buggy client could
-- otherwise spend a business's OCR budget in a tight loop. This is enforced
-- in Postgres, not in the edge function process, because the function has no
-- durable memory of its own between invocations and may run as many
-- concurrent instances.
--
-- Same shape as payment_counters / receipt_counters: RLS on, no policy at
-- all, so the only way in or out is the SECURITY DEFINER function below.
-- =============================================================================

create table if not exists public.ocr_requests (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index if not exists ocr_requests_business_created_idx
  on public.ocr_requests (business_id, created_at);
create index if not exists ocr_requests_user_created_idx
  on public.ocr_requests (user_id, created_at);

alter table public.ocr_requests enable row level security;

-- ponytail: rows accumulate with no purge job — see docs/PHASE_6A_OCR.md
-- "Known limitations" for the pg_cron shape to add if the table's size ever
-- becomes a problem worth solving.

-- ---------------------------------------------------------------------------
-- check_ocr_rate_limit : "has this business or this caller asked for OCR too
-- many times in the last minute?"
--
-- Records the attempt and returns whether it may proceed, in one call, so a
-- burst of concurrent requests cannot all read the same under-limit count
-- before any of them writes a row.
-- ---------------------------------------------------------------------------
create or replace function public.check_ocr_rate_limit(p_business_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user           uuid := auth.uid();
  v_business_count int;
  v_user_count     int;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  if not public.has_business_permission(p_business_id, 'payments.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- One writer per business at a time, so two requests racing at the limit
  -- cannot both read "19" and both be let through.
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text, 1));

  select count(*) into v_business_count
  from public.ocr_requests
  where business_id = p_business_id
    and created_at > now() - interval '1 minute';

  select count(*) into v_user_count
  from public.ocr_requests
  where business_id = p_business_id
    and user_id = v_user
    and created_at > now() - interval '1 minute';

  -- Mirrors OCR_BUSINESS_RATE_LIMIT_PER_MINUTE / OCR_USER_RATE_LIMIT_PER_MINUTE
  -- in packages/shared/src/ocr.ts's shouldThrottleOcr().
  if v_business_count >= 20 or v_user_count >= 8 then
    return false;
  end if;

  insert into public.ocr_requests (business_id, user_id) values (p_business_id, v_user);
  return true;
end;
$$;

revoke all on function public.check_ocr_rate_limit(uuid) from public;
grant execute on function public.check_ocr_rate_limit(uuid) to authenticated;
