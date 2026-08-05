-- =============================================================================
-- Phase 3 authorisation: new permissions + RLS on customers and customer_notes.
--
-- Rules encoded here:
--   * Staff   — search, read, create and correct customers, and add notes.
--   * Manager — the above, plus archive/restore, edit any note, import, export.
--   * Owner   — everything.
--   * Archiving is not reachable through UPDATE; it is an RPC (next migration).
--   * Neither table grants DELETE: bookings and payments will point at these
--     rows from Phase 4 onward, so nothing here is ever erased.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permission matrix additions. `customers.manage` already exists from Phase 1
-- for all three roles and keeps its meaning: read, create, edit, add a note.
-- Mirrored by packages/shared/src/roles.ts; roles.test.ts fails if they drift.
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role, permission) values
  -- archive / restore a customer
  ('owner',   'customers.archive'),
  ('manager', 'customers.archive'),
  -- edit or archive a note somebody else wrote
  ('owner',   'customers.notes.manage'),
  ('manager', 'customers.notes.manage'),
  -- bulk operations: staff may not move the customer list in or out
  ('owner',   'customers.import'),
  ('manager', 'customers.import'),
  ('owner',   'customers.export'),
  ('manager', 'customers.export')
on conflict (role, permission) do nothing;

-- ---------------------------------------------------------------------------
-- RLS + privileges
-- ---------------------------------------------------------------------------
alter table public.customers      enable row level security;
alter table public.customer_notes enable row level security;

revoke all on public.customers, public.customer_notes from anon, authenticated;

grant select, insert, update on public.customers      to authenticated;
grant select, insert, update on public.customer_notes to authenticated;

-- ---------------------------------------------------------------------------
-- customers
--
-- business_id arrives from the client on INSERT. `has_business_permission`
-- resolves the caller's role from auth.uid() for exactly that business, so a
-- forged id buys nothing: the caller is simply not a member of it.
--
-- Unlike properties, archived rows stay selectable — the list has an "archived"
-- filter, restoring needs to read the row first, and duplicate detection has to
-- be able to say "that number belongs to a customer you archived".
-- ---------------------------------------------------------------------------
drop policy if exists customers_select on public.customers;
create policy customers_select
  on public.customers for select to authenticated
  using (public.has_business_permission(business_id, 'customers.manage'));

drop policy if exists customers_insert on public.customers;
create policy customers_insert
  on public.customers for insert to authenticated
  with check (
    archived_at is null
    and public.has_business_permission(business_id, 'customers.manage')
    -- created_by is an audit column; it may only ever be the caller.
    and (created_by is null or created_by = auth.uid())
  );

-- WITH CHECK repeats `archived_at is null`, so archiving cannot be done here —
-- set_customer_archived() is the only path, and it needs customers.archive.
-- USING repeats it too, so an archived customer is read-only until restored.
drop policy if exists customers_update on public.customers;
create policy customers_update
  on public.customers for update to authenticated
  using (archived_at is null and public.has_business_permission(business_id, 'customers.manage'))
  with check (
    archived_at is null and public.has_business_permission(business_id, 'customers.manage')
  );

-- ---------------------------------------------------------------------------
-- customer_notes — authorisation inherited from the customer through the
-- composite FK: (customer_id, business_id) must exist in customers, so a note
-- can never be attached to another tenant's customer.
-- ---------------------------------------------------------------------------
drop policy if exists customer_notes_select on public.customer_notes;
create policy customer_notes_select
  on public.customer_notes for select to authenticated
  using (public.has_business_permission(business_id, 'customers.manage'));

-- Staff may add notes: writing down "arrives late, pays cash" is the job.
drop policy if exists customer_notes_insert on public.customer_notes;
create policy customer_notes_insert
  on public.customer_notes for insert to authenticated
  with check (
    archived_at is null
    and public.has_business_permission(business_id, 'customers.manage')
    and (created_by is null or created_by = auth.uid())
  );

-- Editing or archiving a note — including one's own — is owner/manager work.
-- There is no DELETE grant, so archived_at is how a note goes away.
drop policy if exists customer_notes_update on public.customer_notes;
create policy customer_notes_update
  on public.customer_notes for update to authenticated
  using (public.has_business_permission(business_id, 'customers.notes.manage'))
  with check (public.has_business_permission(business_id, 'customers.notes.manage'));
