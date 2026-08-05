import { CUSTOMER_PAGE_SIZE, customerSearchFilter, normalizePhone } from '@homestay/shared';
import type {
  Customer,
  CustomerFilter,
  CustomerInput,
  CustomerNote,
  TranslationKey,
} from '@homestay/shared';
import { supabase } from '@/lib/supabase';

/**
 * Customer queries for the app. Every call is scoped by `business_id` on top of
 * RLS — the policies are the boundary, the filter just keeps a mistake loud.
 *
 * The search filter, the phone normalisation and the duplicate rule all come
 * from `@homestay/shared`, so this screen and the web one cannot drift apart.
 */

export interface CustomerPage {
  customers: Customer[];
  /** True when there is at least one more row past this page. */
  hasMore: boolean;
}

export interface DuplicateMatch {
  id: string;
  full_name: string;
  phone: string;
  archived: boolean;
}

export async function listCustomers(
  businessId: string,
  options: { search?: string; filter?: CustomerFilter; page?: number } = {},
): Promise<CustomerPage> {
  const page = Math.max(1, options.page ?? 1);
  // One extra row answers "is there more?" without a second count query.
  const limit = page * CUSTOMER_PAGE_SIZE;

  let query = supabase
    .from('customers')
    .select('*')
    .eq('business_id', businessId)
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
  businessId: string,
  customerId: string,
): Promise<Customer | null> {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('business_id', businessId)
    .eq('id', customerId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as Customer) ?? null;
}

/** Internal notes. Archived notes stay in the table but leave the screen. */
export async function listCustomerNotes(
  businessId: string,
  customerId: string,
): Promise<CustomerNote[]> {
  const { data, error } = await supabase
    .from('customer_notes')
    .select('*')
    .eq('business_id', businessId)
    .eq('customer_id', customerId)
    .is('archived_at', null)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as CustomerNote[];
}

/**
 * Duplicate detection. Phone only — two guests really can share a name, and
 * merging them on that basis would lose one of their histories. Archived
 * customers count: "that number belongs to someone you archived" is the answer
 * the person adding them needs.
 */
export async function findCustomerByPhone(
  businessId: string,
  phone: string,
  excludeId?: string,
): Promise<DuplicateMatch | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  let query = supabase
    .from('customers')
    .select('id, full_name, phone, archived_at')
    .eq('business_id', businessId)
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

// --- writes -----------------------------------------------------------------

/** Null when the write succeeded, otherwise the message key to show. */
export type WriteResult = TranslationKey | null;

/** 23505 is the unique index on (business_id, normalized_phone). */
function writeError(error: { code?: string } | null): WriteResult {
  if (!error) return null;
  if (error.code === '23505') return 'customer.duplicate.error';
  return 'error.generic';
}

// normalized_phone is written by a trigger, never sent from the client: a
// forged value would hide the row from duplicate detection.
function toRow(input: CustomerInput) {
  return {
    full_name: input.fullName,
    phone: input.phone,
    phone_secondary: input.phoneSecondary,
    email: input.email,
    facebook_name: input.facebookName,
    facebook_url: input.facebookUrl,
    telegram_username: input.telegramUsername,
    preferred_language: input.preferredLanguage,
    address: input.address,
    note: input.note,
  };
}

export async function createCustomer(
  businessId: string,
  input: CustomerInput,
): Promise<{ id: string | null; errorKey: WriteResult }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('customers')
    .insert({ business_id: businessId, ...toRow(input), created_by: user?.id ?? null })
    .select('id')
    .maybeSingle();

  const errorKey = writeError(error);
  return { id: errorKey ? null : ((data as { id: string } | null)?.id ?? null), errorKey };
}

export async function updateCustomer(
  businessId: string,
  customerId: string,
  input: CustomerInput,
): Promise<WriteResult> {
  const { error } = await supabase
    .from('customers')
    .update(toRow(input))
    .eq('id', customerId)
    .eq('business_id', businessId);

  return writeError(error);
}

/** Archive and restore. The UPDATE policy cannot reach `archived_at`. */
export async function setCustomerArchived(
  customerId: string,
  archived: boolean,
): Promise<WriteResult> {
  const { error } = await supabase.rpc('set_customer_archived', {
    p_customer_id: customerId,
    p_archived: archived,
  });
  return writeError(error);
}

export async function addCustomerNote(
  businessId: string,
  customerId: string,
  body: string,
): Promise<WriteResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from('customer_notes').insert({
    business_id: businessId,
    customer_id: customerId,
    body,
    created_by: user?.id ?? null,
  });

  return writeError(error);
}

/** "Remove" in the UI. Archived, not deleted — there is no DELETE grant. */
export async function archiveCustomerNote(
  businessId: string,
  noteId: string,
): Promise<WriteResult> {
  const { error } = await supabase
    .from('customer_notes')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', noteId)
    .eq('business_id', businessId);

  return writeError(error);
}
