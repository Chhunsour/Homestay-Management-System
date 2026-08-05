-- =============================================================================
-- Phase 5 storage: the private `payment-proofs` bucket and its RLS.
--
-- Object key layout, enforced by both the bucket policies and the
-- payment_proofs INSERT policy:
--
--   businesses/{businessId}/payments/{paymentId}/{fileName}
--
-- Same shape as property-photos, same tenant element (2), same permission
-- matrix. The only difference is what the bucket holds and who may write it.
--
-- No delete policy and no update policy: a payment proof is evidence. A
-- screenshot attached to the wrong payment is dealt with by voiding or
-- correcting the payment, which leaves an audit row, not by quietly removing
-- the picture. The one exception is the upload-rollback path in the client,
-- which cannot delete either — so it retries instead.
--
-- PDFs are allowed here (a bank statement export is a normal thing to be sent)
-- where property-photos takes images only.
--
-- Guarded on the storage schema existing, because the SQL test harness runs on
-- bare postgres with no Storage API.
-- =============================================================================

create or replace function public.can_access_payment_object(
  p_name       text,
  p_permission text
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_name ~ '^businesses/[0-9a-fA-F-]{36}/payments/[0-9a-fA-F-]{36}/.+$'
      then public.has_business_permission(split_part(p_name, '/', 2)::uuid, p_permission)
    else false
  end;
$$;

comment on function public.can_access_payment_object(text, text) is
  'Tenant check for storage.objects keys under businesses/{id}/payments/{id}/.';

revoke all on function public.can_access_payment_object(text, text) from public;
grant execute on function public.can_access_payment_object(text, text) to authenticated;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'storage schema absent (bare postgres) - skipping bucket setup';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'payment-proofs', 'payment-proofs', false, 10485760,
    array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  )
  on conflict (id) do update
    set public             = excluded.public,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute $p$drop policy if exists payment_proofs_object_select on storage.objects$p$;
  execute $p$
    create policy payment_proofs_object_select
      on storage.objects for select to authenticated
      using (
        bucket_id = 'payment-proofs'
        and public.can_access_payment_object(name, 'payments.manage')
      )
  $p$;

  execute $p$drop policy if exists payment_proofs_object_insert on storage.objects$p$;
  execute $p$
    create policy payment_proofs_object_insert
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'payment-proofs'
        and public.can_access_payment_object(name, 'payments.manage')
      )
  $p$;
end
$$;
