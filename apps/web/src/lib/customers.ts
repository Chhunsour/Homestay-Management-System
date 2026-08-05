import { CUSTOMER_PAGE_SIZE, customerSearchFilter, normalizePhone } from '@homestay/shared';
import type { BusinessContext, Customer, CustomerFilter, CustomerNote } from '@homestay/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Read helpers for the customer screens.
 *
 * Every query is scoped by `business_id` as well as being behind RLS. The
 * filter is not the security boundary — the policies are — but it keeps an
 * accidental cross-tenant query from silently returning nothing.
 */

export interface CustomerPage {
  customers: Customer[];
  /** True when the next page has at least one more row. */
  hasMore: boolean;
}

export interface DuplicateMatch {
  id: string;
  full_name: string;
  phone: string;
  archived: boolean;
}

export async function listCustomers(
  context: BusinessContext,
  options: { search?: string; filter?: CustomerFilter; page?: number } = {},
): Promise<CustomerPage> {
  const supabase = await createSupabaseServerClient();
  const page = Math.max(1, options.page ?? 1);
  // One extra row answers "is there more?" without a second count query.
  const limit = page * CUSTOMER_PAGE_SIZE;

  let query = supabase
    .from('customers')
    .select('*')
    .eq('business_id', context.business_id)
    .order('full_name', { ascending: true })
    .range(0, limit);

  if (options.filter === 'active') query = query.is('archived_at', null);
  if (options.filter === 'archived') query = query.not('archived_at', 'is', null);

  const filter = customerSearchFilter(options.search ?? '');
  if (filter) query = query.or(filter);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Customer[];
  return { customers: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function getCustomer(
  context: BusinessContext,
  customerId: string,
): Promise<Customer | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('business_id', context.business_id)
    .eq('id', customerId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as Customer) ?? null;
}

/** Internal notes. Archived notes stay in the table but leave the screen. */
export async function listCustomerNotes(
  context: BusinessContext,
  customerId: string,
): Promise<CustomerNote[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('customer_notes')
    .select('*')
    .eq('business_id', context.business_id)
    .eq('customer_id', customerId)
    .is('archived_at', null)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as CustomerNote[];
}

/**
 * Duplicate detection. Phone only — two guests really can share a name, and
 * merging them on that basis would lose one of their histories.
 *
 * Archived customers are included: "that number belongs to someone you
 * archived" is the answer the person adding them needs.
 */
export async function findCustomerByPhone(
  context: BusinessContext,
  phone: string,
  excludeId?: string,
): Promise<DuplicateMatch | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('customers')
    .select('id, full_name, phone, archived_at')
    .eq('business_id', context.business_id)
    .eq('normalized_phone', normalized)
    .order('archived_at', { ascending: true, nullsFirst: true })
    .limit(1);

  if (excludeId) query = query.neq('id', excludeId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const row = (data ?? [])[0] as
    { id: string; full_name: string; phone: string; archived_at: string | null } | undefined;
  if (!row) return null;

  return {
    id: row.id,
    full_name: row.full_name,
    phone: row.phone,
    archived: row.archived_at !== null,
  };
}

/** Normalised phones from `phones` that already belong to a customer here. */
export async function existingPhones(
  context: BusinessContext,
  phones: readonly string[],
): Promise<string[]> {
  const normalized = [...new Set(phones.map(normalizePhone).filter((v) => v !== null))];
  if (normalized.length === 0) return [];

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('customers')
    .select('normalized_phone')
    .eq('business_id', context.business_id)
    .in('normalized_phone', normalized);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => (row as { normalized_phone: string }).normalized_phone);
}
