-- =============================================================================
-- Phase 6C: connecting a reviewed OCR result to a booking and a payment.
--
-- One new door in: record_ocr_payment(). It does not reinvent anything Phase 4
-- or Phase 5 already enforce — it calls save_booking() and record_payment()
-- from inside its own body. Calling one PL/pgSQL function from another shares
-- the caller's transaction (there is no implicit SAVEPOINT), so if
-- record_payment() raises, the booking save_booking() just made is rolled back
-- with it. That single fact is the whole of this phase's transaction safety:
-- booking, payment and status flip either all happen or none do, and every
-- lock, permission check, conflict scan, duplicate check and price rule the
-- two inner functions already have keeps working unchanged.
--
-- The only genuinely new pieces are:
--   * payment_ocr_reviews — what the reviewer saw, corrected and confirmed,
--     kept for audit next to the payment it produced.
--   * the "this screenshot is already on a payment" duplicate signal, which
--     neither save_booking nor record_payment could know about on their own.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- payment_ocr_reviews — one row per OCR-assisted (or manually-entered-instead)
-- payment. Insert-only, written by record_ocr_payment() alone, same shape as
-- payment_adjustments: an audit trail, never a place a client writes directly.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_ocr_reviews (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete cascade,
  payment_id       uuid not null,
  -- The proof this extraction was read from, when there was one already
  -- stored. Not composite-FK'd to (id, business_id): the row is written by a
  -- SECURITY DEFINER function that has already checked the two match, and
  -- payment_proofs carries no (id, business_id) unique key to hang one on.
  proof_id         uuid references public.payment_proofs (id) on delete set null,
  manual_entry     boolean not null default false,
  -- Free text, not an enum: a provider name is display metadata, never a rule
  -- anything branches on. Null on a manual entry.
  provider         text,
  -- The provider's OcrExtraction verbatim, or null when manual_entry is true.
  extraction       jsonb,
  -- The eight reviewed fields as OCR first produced them, and as the reviewer
  -- ultimately confirmed them — both plain field maps, not the whole payload.
  original_values  jsonb not null,
  corrected_values jsonb not null,
  edited_fields    text[] not null default '{}',
  reviewed_by      uuid references auth.users (id) on delete set null,
  reviewed_at      timestamptz not null default now(),

  constraint payment_ocr_reviews_payment_key unique (payment_id),
  constraint payment_ocr_reviews_manual_check
    check (manual_entry or (provider is not null and extraction is not null)),
  constraint payment_ocr_reviews_payment_fkey foreign key (payment_id, business_id)
    references public.payments (id, business_id) on delete restrict
);

create index if not exists payment_ocr_reviews_proof_idx
  on public.payment_ocr_reviews (proof_id) where proof_id is not null;

alter table public.payment_ocr_reviews enable row level security;

revoke all on public.payment_ocr_reviews from anon, authenticated;

-- Same visibility as the payment it belongs to. No insert/update/delete grant:
-- record_ocr_payment() is SECURITY DEFINER and is the only writer.
grant select on public.payment_ocr_reviews to authenticated;

drop policy if exists payment_ocr_reviews_select on public.payment_ocr_reviews;
create policy payment_ocr_reviews_select
  on public.payment_ocr_reviews for select to authenticated
  using (public.has_business_permission(business_id, 'payments.manage'));

-- ---------------------------------------------------------------------------
-- record_ocr_payment : the one write behind "Confirm" on the OCR review flow.
--
-- Booking mode is decided by p_booking_id:
--   * not null -> attach the payment to that existing booking. The booking is
--     re-read and business-scoped here; nothing about it is created or moved.
--   * null     -> create the booking first, via save_booking() itself, so the
--     new-booking path gets the exact same advisory lock, conflict scan, price
--     authority and override rules a plain booking save gets. p_property_id,
--     p_check_in and p_check_out are required in this branch.
--
-- Either way, record_payment() then does what it always does: lock the
-- booking, check for a duplicate reference, check for an overpayment, insert
-- the row and flip a pending booking to confirmed once the deposit is met.
-- =============================================================================
create or replace function public.record_ocr_payment(
  p_business_id      uuid,
  p_amount           numeric,
  p_method           public.payment_method,
  -- booking selection
  p_booking_id       uuid default null,
  p_property_id      uuid default null,
  p_customer_id      uuid default null,
  p_check_in         timestamptz default null,
  p_check_out        timestamptz default null,
  p_final_price      numeric default null,
  p_price_reason     text default null,
  p_conflict_override boolean default false,
  p_conflict_reason  text default null,
  p_booking_source   text default 'other',
  p_booking_note     text default null,
  -- payment
  p_payment_type     public.payment_type default 'deposit',
  p_paid_at          timestamptz default null,
  p_reference        text default null,
  p_payer_name       text default null,
  p_note             text default null,
  p_duplicate_override   boolean default false,
  p_overpayment_override boolean default false,
  p_override_reason      text default null,
  -- OCR audit
  p_proof_id         uuid default null,
  p_provider         text default null,
  p_extraction       jsonb default null,
  p_original_values  jsonb default '{}'::jsonb,
  p_corrected_values jsonb default '{}'::jsonb,
  p_edited_fields    text[] default '{}',
  p_manual_entry     boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user           uuid := auth.uid();
  v_booking        public.bookings;
  v_payment        public.payments;
  v_proof_business uuid;
  v_proof_payment  uuid;
  v_existing       jsonb;
  v_review_id      uuid;
begin
  if v_user is null then
    raise exception 'auth_required' using errcode = '28000';
  end if;

  -- Recording a payment is the one thing both branches always do.
  if not public.has_business_permission(p_business_id, 'payments.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- A screenshot already attached to a payment is worth knowing about before
  -- another one gets created from the same reviewed data — save_booking and
  -- record_payment have no way to know this on their own.
  if p_proof_id is not null then
    select business_id, payment_id into v_proof_business, v_proof_payment
    from public.payment_proofs where id = p_proof_id;

    if v_proof_business is null or v_proof_business <> p_business_id then
      raise exception 'proof_not_found' using errcode = 'P0002';
    end if;

    if v_proof_payment is not null and not p_duplicate_override then
      select jsonb_build_array(jsonb_build_object(
               'kind', 'file', 'id', pm.id, 'payment_number', pm.payment_number,
               'amount', pm.amount, 'currency', pm.currency,
               'paid_at', pm.paid_at, 'reference', pm.reference, 'status', pm.status))
      into v_existing
      from public.payments pm where pm.id = v_proof_payment;

      raise exception 'duplicate_payment' using errcode = '23505', detail = v_existing::text;
    end if;
  end if;

  if p_booking_id is not null then
    select * into v_booking
    from public.bookings
    where id = p_booking_id and business_id = p_business_id;

    if v_booking.id is null then
      raise exception 'booking_not_found' using errcode = 'P0002';
    end if;
  else
    if p_property_id is null or p_check_in is null or p_check_out is null
       or p_customer_id is null then
      raise exception 'invalid_request' using errcode = '22023';
    end if;

    -- Every lock, conflict check, price rule and override permission a plain
    -- booking save gets — reused whole, not re-implemented.
    v_booking := public.save_booking(
      p_business_id      => p_business_id,
      p_property_id      => p_property_id,
      p_customer_id      => p_customer_id,
      p_check_in         => p_check_in,
      p_check_out        => p_check_out,
      p_source           => p_booking_source,
      p_note             => p_booking_note,
      p_final_price      => p_final_price,
      p_price_reason     => p_price_reason,
      p_conflict_override => p_conflict_override,
      p_conflict_reason  => p_conflict_reason
    );
  end if;

  -- The booking lock, duplicate-reference check, overpayment check, insert
  -- and confirm-on-deposit flip — reused whole. If this raises, the insert
  -- save_booking() may just have made above rolls back with it: one RPC call
  -- is one transaction, and nothing here opens a subtransaction to catch it.
  v_payment := public.record_payment(
    p_booking_id   => v_booking.id,
    p_amount       => p_amount,
    p_method       => p_method,
    p_payment_type => p_payment_type,
    p_paid_at      => p_paid_at,
    p_reference    => p_reference,
    p_payer_name   => p_payer_name,
    p_note         => p_note,
    p_duplicate_override   => p_duplicate_override,
    p_overpayment_override => p_overpayment_override,
    p_override_reason      => p_override_reason
  );

  insert into public.payment_ocr_reviews (
    business_id, payment_id, proof_id, manual_entry, provider, extraction,
    original_values, corrected_values, edited_fields, reviewed_by
  )
  values (
    p_business_id, v_payment.id, p_proof_id, p_manual_entry, p_provider, p_extraction,
    coalesce(p_original_values, '{}'::jsonb), coalesce(p_corrected_values, '{}'::jsonb),
    coalesce(p_edited_fields, '{}'), v_user
  )
  returning id into v_review_id;

  return jsonb_build_object(
    'booking_id', v_booking.id,
    'booking_number', v_booking.booking_number,
    'payment_id', v_payment.id,
    'payment_number', v_payment.payment_number,
    'ocr_review_id', v_review_id
  );
end;
$$;

revoke all on function public.record_ocr_payment(
  uuid, numeric, public.payment_method,
  uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, text, text,
  public.payment_type, timestamptz, text, text, text, boolean, boolean, text,
  uuid, text, jsonb, jsonb, jsonb, text[], boolean
) from public, anon;

grant execute on function public.record_ocr_payment(
  uuid, numeric, public.payment_method,
  uuid, uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, text, text,
  public.payment_type, timestamptz, text, text, text, boolean, boolean, text,
  uuid, text, jsonb, jsonb, jsonb, text[], boolean
) to authenticated;
