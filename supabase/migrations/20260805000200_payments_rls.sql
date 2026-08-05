-- =============================================================================
-- Phase 5 authorisation: new permissions + RLS on the payment tables.
--
-- Rules encoded here:
--   * Staff   — see what a booking owes, record a payment, upload a proof.
--               That is the whole list. They cannot verify, correct, void,
--               refund, or push a payment past a duplicate warning.
--   * Manager — the above, plus verify, correct with a reason, refund, and
--               override a duplicate or an overpayment with a reason.
--   * Owner   — everything, including voiding a payment outright.
--   * Nobody, at any level, gets UPDATE or DELETE on payments. Every change of
--     state goes through the RPCs in the next migration, which re-check the
--     role, re-read the row and write the audit record in the same
--     transaction. The missing grant is what enforces that.
--
-- Voiding is owner-only on purpose. It is the one action that makes money stop
-- counting without leaving a compensating row behind, which puts it in the same
-- drawer as properties.archive and bookings.restore.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permission matrix additions. `payments.manage` already exists from Phase 1
-- for owner and manager; staff join it here, because the person who takes the
-- screenshot on Messenger at 9pm is usually staff.
-- Mirrored by packages/shared/src/roles.ts; roles.test.ts fails if they drift.
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role, permission) values
  -- view balances, record a payment, upload a proof
  ('staff',   'payments.manage'),
  -- confirm the money actually arrived
  ('owner',   'payments.verify'),
  ('manager', 'payments.verify'),
  -- change a wrong amount, leaving the old one in the audit trail
  ('owner',   'payments.correct'),
  ('manager', 'payments.correct'),
  ('owner',   'payments.refund'),
  ('manager', 'payments.refund'),
  -- make a payment stop counting entirely: the owner's call alone
  ('owner',   'payments.void'),
  -- save past a duplicate-reference or overpayment warning, with a reason
  ('owner',   'payments.override'),
  ('manager', 'payments.override'),
  ('owner',   'receipts.manage'),
  ('manager', 'receipts.manage')
on conflict (role, permission) do nothing;

-- ---------------------------------------------------------------------------
-- RLS + privileges
-- ---------------------------------------------------------------------------
alter table public.payments            enable row level security;
alter table public.payment_proofs      enable row level security;
alter table public.payment_adjustments enable row level security;
alter table public.receipts            enable row level security;
alter table public.payment_counters    enable row level security;
alter table public.receipt_counters    enable row level security;

revoke all on public.payments, public.payment_proofs, public.payment_adjustments,
              public.receipts, public.payment_counters, public.receipt_counters
  from anon, authenticated;

-- Read-only from the client's side of the wire. No insert, no update, no
-- delete: record_payment / verify_payment / correct_payment / void_payment /
-- refund_payment / issue_receipt are the only doors.
grant select on public.payments            to authenticated;
grant select on public.payment_adjustments to authenticated;
grant select on public.receipts            to authenticated;

-- Proofs are the one exception. The bytes go straight to storage from the
-- device, so the metadata row is inserted by the client too — the storage
-- policy and the CHECK constraints already decide what is allowed to exist.
-- Delete stays out: an uploaded proof is evidence.
grant select, insert on public.payment_proofs to authenticated;

-- The counter tables get no grant at all: only next_payment_number() and
-- next_receipt_number() (SECURITY DEFINER) touch them, and RLS with no policy
-- denies everything else.

-- ---------------------------------------------------------------------------
-- payments — everyone who may manage payments reads their own business's rows.
-- has_business_permission resolves the caller's role from auth.uid() for
-- exactly the row's business, so a forged business_id in a query buys nothing.
-- ---------------------------------------------------------------------------
drop policy if exists payments_select on public.payments;
create policy payments_select
  on public.payments for select to authenticated
  using (public.has_business_permission(business_id, 'payments.manage'));

-- ---------------------------------------------------------------------------
-- payment_proofs — visible to the same people, uploadable by them, and only
-- ever attached to a payment of their own business (the composite FK makes the
-- second half structural).
-- ---------------------------------------------------------------------------
drop policy if exists payment_proofs_select on public.payment_proofs;
create policy payment_proofs_select
  on public.payment_proofs for select to authenticated
  using (public.has_business_permission(business_id, 'payments.manage'));

drop policy if exists payment_proofs_insert on public.payment_proofs;
create policy payment_proofs_insert
  on public.payment_proofs for insert to authenticated
  with check (
    public.has_business_permission(business_id, 'payments.manage')
    -- The object key must sit under this business's prefix, or a signed URL
    -- could be minted for a path the storage policy would have refused.
    and storage_path like 'businesses/' || business_id::text || '/payments/%'
    and exists (
      select 1 from public.payments p
      where p.id = payment_id and p.business_id = payment_proofs.business_id
    )
  );

-- ---------------------------------------------------------------------------
-- payment_adjustments — the audit trail. Readable, never writable from a
-- client: the RPCs write it as definer, in the same transaction as the change
-- it explains.
-- ---------------------------------------------------------------------------
drop policy if exists payment_adjustments_select on public.payment_adjustments;
create policy payment_adjustments_select
  on public.payment_adjustments for select to authenticated
  using (public.has_business_permission(business_id, 'payments.manage'));

-- ---------------------------------------------------------------------------
-- receipts — anyone who may see the money may see the receipt. Issuing one
-- needs receipts.manage and goes through issue_receipt().
-- ---------------------------------------------------------------------------
drop policy if exists receipts_select on public.receipts;
create policy receipts_select
  on public.receipts for select to authenticated
  using (public.has_business_permission(business_id, 'payments.manage'));

-- ---------------------------------------------------------------------------
-- Internal helpers: not callable by a client. next_payment_number() would let
-- anyone burn another business's sequence; booking_payment_summary() is a
-- definer function and is exposed deliberately, because reading what a booking
-- owes is the whole point — it checks membership itself and returns no row to
-- an outsider.
-- ---------------------------------------------------------------------------
revoke all on function public.next_payment_number(uuid, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.next_receipt_number(uuid, timestamptz, text)
  from public, anon, authenticated;

revoke all on function public.booking_payment_summary(uuid) from public, anon;
grant execute on function public.booking_payment_summary(uuid) to authenticated;

-- The view runs as the invoker, so the payments and bookings policies still
-- apply row by row; the grant only decides who may name it.
revoke all on public.booking_payment_totals from anon, authenticated;
grant select on public.booking_payment_totals to authenticated;
