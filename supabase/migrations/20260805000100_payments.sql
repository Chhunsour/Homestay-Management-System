-- =============================================================================
-- Phase 5 schema: payments, payment proofs, adjustments, receipts.
--
-- Three rules shape everything below.
--
--   1. Money is never deleted. A wrong payment is voided or corrected, and the
--      before/after pair lands in payment_adjustments. There is no DELETE grant
--      on any table here.
--   2. No balance column anywhere. What a booking owes is derived from its
--      payment rows every time it is asked — a stored total is a number that
--      can be edited into a lie.
--   3. A payment belongs to exactly one business, and to a booking and a
--      customer of that same business. Composite foreign keys make that
--      structural, not a matter of the caller behaving.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Vocabularies. Same guarded-do idiom as booking_status_code, so re-running the
-- migration on a database that already has them is a no-op.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'payment_method') then
    create type public.payment_method as enum ('aba', 'khqr', 'bank_transfer', 'cash');
  end if;
  if not exists (select 1 from pg_type where typname = 'payment_type') then
    -- 'refund' rows carry a positive amount and are subtracted, never negative:
    -- a negative amount in a money column is one lost minus sign from disaster.
    create type public.payment_type as enum
      ('deposit', 'balance', 'full', 'refund', 'adjustment');
  end if;
  if not exists (select 1 from pg_type where typname = 'payment_status') then
    -- recorded : entered, not checked against the bank yet
    -- verified : somebody with payments.verify confirmed it arrived
    -- voided   : never happened; excluded from every total
    -- refunded : happened, and has since been refunded by a 'refund' row
    create type public.payment_status as enum
      ('recorded', 'verified', 'voided', 'refunded');
  end if;
  if not exists (select 1 from pg_type where typname = 'payment_adjustment_action') then
    create type public.payment_adjustment_action as enum ('void', 'correct', 'refund');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- payment_counters / receipt_counters — one sequence per business per year.
--
-- A plain sequence would be global and would leak how many payments every other
-- business takes. The upsert below locks one row, so simultaneous callers
-- serialise on it and nobody gets the same number twice.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_counters (
  business_id uuid not null references public.businesses (id) on delete cascade,
  year        integer not null,
  last_number bigint not null default 0,
  primary key (business_id, year)
);

create table if not exists public.receipt_counters (
  business_id uuid not null references public.businesses (id) on delete cascade,
  year        integer not null,
  last_number bigint not null default 0,
  primary key (business_id, year)
);

-- ---------------------------------------------------------------------------
-- payments — one row per money movement. Nothing here is edited in place
-- except its status and verification: corrections write a new amount *and* an
-- adjustment row, in one transaction.
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses (id) on delete cascade,
  booking_id     uuid not null,
  -- Denormalised from the booking on purpose: a payment must still answer
  -- "whose money was this" without a join, and the composite FK below keeps
  -- the two from ever pointing at different businesses.
  customer_id    uuid not null,

  payment_number text not null,
  amount         numeric(12,2) not null,
  -- Copied from the booking, never chosen by the caller: a stay quoted in KHR
  -- is paid in KHR, and the rate that applied on the day stays with the row.
  currency       public.app_currency not null,
  exchange_rate  numeric(14,6),

  method         public.payment_method not null,
  payment_type   public.payment_type not null,
  status         public.payment_status not null default 'recorded',

  paid_at        timestamptz not null,
  reference      text,
  payer_name     text,
  note           text,

  -- Set when this row was allowed past a duplicate or overpayment warning.
  -- The reason is required by the CHECK: an override nobody explained is an
  -- override nobody can audit.
  duplicate_override   boolean not null default false,
  overpayment_override boolean not null default false,
  override_reason      text,

  verified_by uuid references auth.users (id) on delete set null,
  verified_at timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint payments_id_business_key unique (id, business_id),
  constraint payments_number_key unique (business_id, payment_number),
  constraint payments_number_check check (payment_number ~ '^PM-[0-9]{4}-[0-9]{6}$'),

  -- Zero is not a payment, and a refund is stored positive like everything else.
  constraint payments_amount_check check (amount > 0),
  constraint payments_exchange_rate_check check (exchange_rate is null or exchange_rate > 0),
  constraint payments_reference_check
    check (reference is null or char_length(btrim(reference)) between 1 and 120),
  constraint payments_payer_check
    check (payer_name is null or char_length(payer_name) <= 200),
  constraint payments_note_check check (note is null or char_length(note) <= 2000),
  constraint payments_override_check
    check (
      (not duplicate_override and not overpayment_override)
      or char_length(btrim(coalesce(override_reason, ''))) >= 3
    ),
  constraint payments_verified_check
    check ((verified_by is null) = (verified_at is null)),

  constraint payments_booking_fkey foreign key (booking_id, business_id)
    references public.bookings (id, business_id) on delete restrict,
  constraint payments_customer_fkey foreign key (customer_id, business_id)
    references public.customers (id, business_id) on delete restrict
);

create index if not exists payments_booking_idx on public.payments (booking_id, paid_at desc);
create index if not exists payments_business_idx on public.payments (business_id, paid_at desc);
create index if not exists payments_customer_idx on public.payments (customer_id, paid_at desc);
create index if not exists payments_reference_idx
  on public.payments (business_id, lower(btrim(reference)))
  where reference is not null;

-- The duplicate block, as a constraint rather than as a hopeful check in the
-- application: one live payment per transaction reference per business. Rows
-- that were explicitly overridden are outside the index, which is what lets an
-- owner record the genuine second transfer that happens to reuse a reference.
-- Voiding a payment frees its reference again.
create unique index if not exists payments_reference_key
  on public.payments (business_id, lower(btrim(reference)))
  where reference is not null and status <> 'voided' and not duplicate_override;

-- ---------------------------------------------------------------------------
-- payment_proofs — the screenshot an owner was sent on Messenger.
-- The bytes live in a private bucket; this is only the metadata.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_proofs (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  payment_id   uuid not null,
  storage_path text not null unique,
  file_name    text not null,
  mime_type    text not null,
  size_bytes   bigint not null,
  -- Optional SHA-256 of the file, when the client could compute one. Used to
  -- warn "you have uploaded this exact screenshot before", never to block.
  checksum     text,
  uploaded_by  uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),

  constraint payment_proofs_mime_check
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  constraint payment_proofs_size_check check (size_bytes between 1 and 10485760),
  constraint payment_proofs_checksum_check
    check (checksum is null or checksum ~ '^[0-9a-f]{64}$'),
  constraint payment_proofs_payment_fkey foreign key (payment_id, business_id)
    references public.payments (id, business_id) on delete restrict
);

create index if not exists payment_proofs_payment_idx on public.payment_proofs (payment_id);
create index if not exists payment_proofs_checksum_idx
  on public.payment_proofs (business_id, checksum) where checksum is not null;

-- ---------------------------------------------------------------------------
-- payment_adjustments — why a payment stopped being what it was.
-- Append only: no update, no delete, no grant to change one after the fact.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_adjustments (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete cascade,
  payment_id        uuid not null,
  action            public.payment_adjustment_action not null,
  reason            text not null,
  original_amount   numeric(12,2) not null,
  -- Null for a void: nothing replaced the amount, it simply stopped counting.
  corrected_amount  numeric(12,2),
  -- The 'refund' payment row this adjustment created, when action = 'refund'.
  refund_payment_id uuid,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),

  constraint payment_adjustments_reason_check check (char_length(btrim(reason)) >= 3),
  constraint payment_adjustments_amounts_check
    check (original_amount >= 0 and (corrected_amount is null or corrected_amount > 0)),
  constraint payment_adjustments_payment_fkey foreign key (payment_id, business_id)
    references public.payments (id, business_id) on delete restrict,
  constraint payment_adjustments_refund_fkey foreign key (refund_payment_id, business_id)
    references public.payments (id, business_id) on delete restrict
);

create index if not exists payment_adjustments_payment_idx
  on public.payment_adjustments (payment_id, created_at desc);

-- ---------------------------------------------------------------------------
-- receipts — a frozen document, not a view.
--
-- `snapshot` holds the guest name, property name, dates and totals as they read
-- at the moment of issue. Renaming the property next month must not silently
-- rewrite a receipt the guest already has in their phone.
-- ---------------------------------------------------------------------------
create table if not exists public.receipts (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses (id) on delete cascade,
  booking_id     uuid not null,
  payment_id     uuid,
  receipt_number text not null,
  language       text not null default 'en',
  snapshot       jsonb not null,
  issued_by      uuid references auth.users (id) on delete set null,
  issued_at      timestamptz not null default now(),
  created_at     timestamptz not null default now(),

  constraint receipts_number_key unique (business_id, receipt_number),
  constraint receipts_number_check check (receipt_number ~ '^RC-[0-9]{4}-[0-9]{6}$'),
  constraint receipts_language_check check (language in ('en', 'km')),
  constraint receipts_snapshot_check check (jsonb_typeof(snapshot) = 'object'),
  constraint receipts_booking_fkey foreign key (booking_id, business_id)
    references public.bookings (id, business_id) on delete restrict,
  constraint receipts_payment_fkey foreign key (payment_id, business_id)
    references public.payments (id, business_id) on delete restrict
);

create index if not exists receipts_booking_idx on public.receipts (booking_id, issued_at desc);
create index if not exists receipts_business_idx on public.receipts (business_id, issued_at desc);

-- updated_at, same helper as every other table.
drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- next_payment_number / next_receipt_number — PM-<year>-<six>, RC-<year>-<six>.
-- Same counter upsert as next_booking_number: the row lock serialises callers.
-- ---------------------------------------------------------------------------
create or replace function public.next_payment_number(
  p_business_id uuid,
  p_at          timestamptz,
  p_timezone    text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_year integer := extract(year from (p_at at time zone p_timezone))::integer;
  v_seq  bigint;
begin
  insert into public.payment_counters (business_id, year, last_number)
  values (p_business_id, v_year, 1)
  on conflict (business_id, year)
  do update set last_number = public.payment_counters.last_number + 1
  returning last_number into v_seq;

  return format('PM-%s-%s', v_year, lpad(v_seq::text, 6, '0'));
end;
$$;

create or replace function public.next_receipt_number(
  p_business_id uuid,
  p_at          timestamptz,
  p_timezone    text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_year integer := extract(year from (p_at at time zone p_timezone))::integer;
  v_seq  bigint;
begin
  insert into public.receipt_counters (business_id, year, last_number)
  values (p_business_id, v_year, 1)
  on conflict (business_id, year)
  do update set last_number = public.receipt_counters.last_number + 1
  returning last_number into v_seq;

  return format('RC-%s-%s', v_year, lpad(v_seq::text, 6, '0'));
end;
$$;

-- ---------------------------------------------------------------------------
-- booking_payment_summary — the single definition of what a booking owes.
--
-- The SQL twin of bookingBalance() in packages/shared/src/payments.ts. Both
-- apps display the shared version; the server decides with this one, and the
-- RPCs never trust a total that arrived from a client.
--
-- Voided rows are excluded. Everything else counts: a payment that has been
-- recorded but not yet verified is still money the guest has sent, and holding
-- a confirmation hostage to an office task is how a deposit gets taken twice.
-- Refunds are their own rows and are subtracted, so net_paid can fall back to
-- zero without any amount ever going negative.
-- ---------------------------------------------------------------------------
create or replace function public.booking_payment_summary(p_booking_id uuid)
returns table (
  booking_id       uuid,
  business_id      uuid,
  currency         public.app_currency,
  booking_total    numeric(12,2),
  deposit_required numeric(12,2),
  total_paid       numeric(12,2),
  refund_total     numeric(12,2),
  net_paid         numeric(12,2),
  balance          numeric(12,2),
  paid_percent     numeric(6,2),
  payment_status   text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with booking as (
    select b.id, b.business_id, b.currency, b.final_price as total
    from public.bookings b
    where b.id = p_booking_id
      and public.is_business_member(b.business_id)
  ),
  totals as (
    select
      coalesce(sum(p.amount) filter (where p.payment_type <> 'refund'), 0)::numeric(12,2) as paid,
      coalesce(sum(p.amount) filter (where p.payment_type =  'refund'), 0)::numeric(12,2) as refunded
    from public.payments p
    where p.booking_id = p_booking_id and p.status <> 'voided'
  )
  select
    booking.id,
    booking.business_id,
    booking.currency,
    booking.total,
    round(booking.total * 0.5, 2),
    totals.paid,
    totals.refunded,
    round(totals.paid - totals.refunded, 2),
    round(booking.total - (totals.paid - totals.refunded), 2),
    case when booking.total > 0
         then round((totals.paid - totals.refunded) * 100 / booking.total, 2)
         else 0 end,
    case
      when totals.paid - totals.refunded <= 0 and totals.refunded > 0 then 'refunded'
      when totals.paid - totals.refunded <= 0                        then 'unpaid'
      when totals.paid - totals.refunded  > booking.total            then 'overpaid'
      when totals.paid - totals.refunded >= booking.total            then 'paid'
      when totals.paid - totals.refunded >= round(booking.total * 0.5, 2) then 'deposit_paid'
      else 'partial'
    end
  from booking cross join totals;
$$;

-- ---------------------------------------------------------------------------
-- booking_payment_totals — the same arithmetic for a whole list, so the
-- payments table, the dashboard and the booking list do not run one function
-- call per row.
--
-- security_invoker: the view runs as the caller, so the RLS policies on
-- bookings and payments are still the boundary. Without it this would be a
-- tenant-wide leak wearing a view's clothes.
-- ---------------------------------------------------------------------------
create or replace view public.booking_payment_totals
with (security_invoker = true) as
select
  b.id          as booking_id,
  b.business_id,
  b.currency,
  b.final_price as booking_total,
  round(b.final_price * 0.5, 2) as deposit_required,
  coalesce(sum(p.amount) filter (where p.payment_type <> 'refund'), 0)::numeric(12,2) as total_paid,
  coalesce(sum(p.amount) filter (where p.payment_type =  'refund'), 0)::numeric(12,2) as refund_total
from public.bookings b
left join public.payments p on p.booking_id = b.id and p.status <> 'voided'
group by b.id, b.business_id, b.currency, b.final_price;

comment on view public.booking_payment_totals is
  'Per-booking payment arithmetic. net_paid, balance and status are derived '
  'from these three numbers by bookingBalance() in @homestay/shared.';
