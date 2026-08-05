-- =============================================================================
-- Phase 4 authorisation: new permissions + RLS on the booking tables.
--
-- Rules encoded here:
--   * Staff   — see the calendar, create bookings, edit basic details, link a
--               customer, add notes. Nothing else.
--   * Manager — the above, plus override a conflict or a price (with a reason),
--               cancel a booking, and rule on an expired hold.
--   * Owner   — everything, including customising the status list and
--               reopening a cancelled booking.
--   * Dates, property, customer, status and price are NOT reachable through
--     UPDATE: those go through the RPCs in the next migration, which take the
--     per-property lock and re-check for conflicts. The `grant update (...)`
--     below is what enforces that — a client that skips the RPC gets a
--     permission error from postgres, not a bypassed conflict check.
--   * No DELETE anywhere: a booking is cancelled, never erased.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permission matrix additions. `bookings.manage` already exists from Phase 1
-- for all three roles and keeps its meaning: view, create, edit, add a note.
-- Mirrored by packages/shared/src/roles.ts; roles.test.ts fails if they drift.
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role, permission) values
  -- rename / recolour / reorder / add booking statuses
  ('owner',   'bookings.statuses.manage'),
  -- book over an existing booking or block, with a recorded reason
  ('owner',   'bookings.conflict.override'),
  ('manager', 'bookings.conflict.override'),
  -- charge something other than what the rate card says
  ('owner',   'bookings.price.override'),
  ('manager', 'bookings.price.override'),
  ('owner',   'bookings.cancel'),
  ('manager', 'bookings.cancel'),
  -- reopening a cancelled booking is the owner's call alone
  ('owner',   'bookings.restore'),
  -- decide what happens to a pending booking whose hold ran out
  ('owner',   'bookings.pending.resolve'),
  ('manager', 'bookings.pending.resolve')
on conflict (role, permission) do nothing;

-- ---------------------------------------------------------------------------
-- RLS + privileges
-- ---------------------------------------------------------------------------
alter table public.booking_statuses       enable row level security;
alter table public.bookings               enable row level security;
alter table public.booking_status_history enable row level security;
alter table public.booking_counters       enable row level security;

revoke all on public.booking_statuses, public.bookings,
              public.booking_status_history, public.booking_counters
  from anon, authenticated;

grant select, insert, update on public.booking_statuses to authenticated;
grant select on public.booking_status_history to authenticated;

-- Read everything the tenant may read; write only the two free-text columns.
-- Everything that affects availability or money is RPC-only.
grant select on public.bookings to authenticated;
grant update (note, internal_note) on public.bookings to authenticated;

-- booking_counters gets no grant at all: only next_booking_number() (SECURITY
-- DEFINER) touches it, and RLS with no policy denies everything else.

-- ---------------------------------------------------------------------------
-- booking_statuses — everyone on the team reads them (the calendar is coloured
-- by them); only an owner changes the list.
-- ---------------------------------------------------------------------------
drop policy if exists booking_statuses_select on public.booking_statuses;
create policy booking_statuses_select
  on public.booking_statuses for select to authenticated
  using (public.has_business_permission(business_id, 'bookings.manage'));

drop policy if exists booking_statuses_insert on public.booking_statuses;
create policy booking_statuses_insert
  on public.booking_statuses for insert to authenticated
  with check (
    -- A client cannot mint a built-in status; only the seed trigger does that.
    is_system = false
    and public.has_business_permission(business_id, 'bookings.statuses.manage')
  );

drop policy if exists booking_statuses_update on public.booking_statuses;
create policy booking_statuses_update
  on public.booking_statuses for update to authenticated
  using (public.has_business_permission(business_id, 'bookings.statuses.manage'))
  with check (public.has_business_permission(business_id, 'bookings.statuses.manage'));

-- ---------------------------------------------------------------------------
-- bookings — one policy per operation, all keyed on membership of the row's
-- own business_id. A forged business id buys nothing: has_business_permission
-- resolves the caller's role from auth.uid() for exactly that business.
--
-- There is no INSERT policy on purpose. create_booking() is the only way in.
-- ---------------------------------------------------------------------------
drop policy if exists bookings_select on public.bookings;
create policy bookings_select
  on public.bookings for select to authenticated
  using (public.has_business_permission(business_id, 'bookings.manage'));

drop policy if exists bookings_update on public.bookings;
create policy bookings_update
  on public.bookings for update to authenticated
  using (public.has_business_permission(business_id, 'bookings.manage'))
  with check (public.has_business_permission(business_id, 'bookings.manage'));

-- ---------------------------------------------------------------------------
-- booking_status_history — read-only history. Written by a trigger running as
-- definer, so no INSERT grant is needed for it to work.
-- ---------------------------------------------------------------------------
drop policy if exists booking_status_history_select on public.booking_status_history;
create policy booking_status_history_select
  on public.booking_status_history for select to authenticated
  using (public.has_business_permission(business_id, 'bookings.manage'));

-- ---------------------------------------------------------------------------
-- Internal helpers: not callable by a client. booking_calculated_price() would
-- otherwise price any property id it is handed, and next_booking_number()
-- would let anyone burn another business's sequence.
-- ---------------------------------------------------------------------------
revoke all on function public.booking_calculated_price(uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.next_booking_number(uuid, timestamptz, text)
  from public, anon, authenticated;
