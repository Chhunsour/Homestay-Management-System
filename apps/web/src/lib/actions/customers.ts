'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  CUSTOMER_IMPORT_MAX_ROWS,
  customerImportRowSchema,
  customerNoteSchema,
  customerSchema,
  customerSearchFilter,
  fieldErrors,
} from '@homestay/shared';
import type { CustomerImportResult } from '@homestay/shared';
import { getBusinessContext, requirePermission } from '@/lib/business';
import { existingPhones, findCustomerByPhone } from '@/lib/customers';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { failure, success, type ActionState } from '@/lib/actions/state';

/**
 * Server Actions for customers.
 *
 * Each one re-reads the caller's business context from the database instead of
 * trusting a business id from the form, then re-checks the permission the
 * policies also check. The database is the boundary; this makes the rejection
 * a translated message rather than an empty result.
 */

/** The existing customer a rejected create ran into, for the "open it" link. */
export interface DuplicateHint {
  id: string;
  name: string;
  phone: string;
}

export interface CustomerActionState extends ActionState {
  duplicate?: DuplicateHint;
}

function readCustomer(formData: FormData) {
  return {
    fullName: formData.get('fullName'),
    phone: formData.get('phone'),
    phoneSecondary: formData.get('phoneSecondary'),
    email: formData.get('email'),
    facebookName: formData.get('facebookName'),
    facebookUrl: formData.get('facebookUrl'),
    telegramUsername: formData.get('telegramUsername'),
    preferredLanguage: formData.get('preferredLanguage'),
    address: formData.get('address'),
    note: formData.get('note'),
  };
}

/** 23505 is the unique index on (business_id, normalized_phone). */
function writeError(error: { code?: string }): CustomerActionState {
  if (error.code === '23505')
    return failure('customer.duplicate.error', { phone: 'customer.duplicate.error' });
  return failure('error.generic');
}

export async function createCustomerAction(
  _prev: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'customers.manage');

  const parsed = customerSchema.safeParse(readCustomer(formData));
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  // ponytail: an archived match blocks the create too — restoring that record
  // keeps the guest's history in one place. Add a force flag only if a real
  // business turns out to need two records for one number.
  const existing = await findCustomerByPhone(context, parsed.data.phone);
  if (existing) {
    return {
      ...failure('customer.duplicate.title', { phone: 'customer.duplicate.error' }),
      duplicate: { id: existing.id, name: existing.full_name, phone: existing.phone },
    };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // normalized_phone is written by a trigger, never accepted from the client:
  // a forged value would hide the row from duplicate detection.
  const { data, error } = await supabase
    .from('customers')
    .insert({
      business_id: context.business_id,
      full_name: parsed.data.fullName,
      phone: parsed.data.phone,
      phone_secondary: parsed.data.phoneSecondary,
      email: parsed.data.email,
      facebook_name: parsed.data.facebookName,
      facebook_url: parsed.data.facebookUrl,
      telegram_username: parsed.data.telegramUsername,
      preferred_language: parsed.data.preferredLanguage,
      address: parsed.data.address,
      note: parsed.data.note,
      created_by: user?.id ?? null,
    })
    .select('id')
    .maybeSingle();
  if (error) return writeError(error);

  const created = data as { id: string } | null;
  revalidatePath('/guests');
  redirect(created ? `/guests/${created.id}` : '/guests');
}

export async function updateCustomerAction(
  _prev: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'customers.manage');

  const customerId = String(formData.get('customerId') ?? '');
  const parsed = customerSchema.safeParse(readCustomer(formData));
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const existing = await findCustomerByPhone(context, parsed.data.phone, customerId);
  if (existing) {
    return {
      ...failure('customer.duplicate.title', { phone: 'customer.duplicate.error' }),
      duplicate: { id: existing.id, name: existing.full_name, phone: existing.phone },
    };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('customers')
    .update({
      full_name: parsed.data.fullName,
      phone: parsed.data.phone,
      phone_secondary: parsed.data.phoneSecondary,
      email: parsed.data.email,
      facebook_name: parsed.data.facebookName,
      facebook_url: parsed.data.facebookUrl,
      telegram_username: parsed.data.telegramUsername,
      preferred_language: parsed.data.preferredLanguage,
      address: parsed.data.address,
      note: parsed.data.note,
    })
    .eq('id', customerId)
    .eq('business_id', context.business_id);
  if (error) return writeError(error);

  revalidatePath('/guests');
  revalidatePath(`/guests/${customerId}`);
  return success('customer.updated');
}

/** Archive and restore. The UPDATE policy cannot reach `archived_at`. */
export async function setCustomerArchivedAction(formData: FormData): Promise<void> {
  const context = await getBusinessContext();
  if (!context) return;
  requirePermission(context, 'customers.archive');

  const customerId = String(formData.get('customerId') ?? '');
  const archived = formData.get('archived') === 'true';

  const supabase = await createSupabaseServerClient();
  await supabase.rpc('set_customer_archived', {
    p_customer_id: customerId,
    p_archived: archived,
  });

  revalidatePath('/guests');
  revalidatePath(`/guests/${customerId}`);
}

// --- internal notes ---------------------------------------------------------

export async function addCustomerNoteAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const context = await getBusinessContext();
  if (!context) return failure('error.unauthorized');
  requirePermission(context, 'customers.manage');

  const parsed = customerNoteSchema.safeParse({
    customerId: formData.get('customerId'),
    body: formData.get('body'),
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from('customer_notes').insert({
    business_id: context.business_id,
    customer_id: parsed.data.customerId,
    body: parsed.data.body,
    created_by: user?.id ?? null,
  });
  if (error) return failure('error.generic');

  revalidatePath(`/guests/${parsed.data.customerId}`);
  return success('customer.notes.added');
}

// --- OCR review inline picker (Phase 6B) ------------------------------------

export interface CustomerOption {
  id: string;
  full_name: string;
  phone: string;
}

/**
 * Search-as-you-type for the OCR review flow's customer step. Same filter as
 * the `/guests` list (`customerSearchFilter`), just returned as data instead
 * of rendered as a page, and capped small since this backs a picker, not a
 * table.
 */
export async function searchCustomersAction(query: string): Promise<CustomerOption[]> {
  const context = await getBusinessContext();
  if (!context) return [];
  try {
    requirePermission(context, 'customers.manage');
  } catch {
    return [];
  }

  const search = query.trim();
  if (!search) return [];

  const supabase = await createSupabaseServerClient();
  let request = supabase
    .from('customers')
    .select('id, full_name, phone')
    .eq('business_id', context.business_id)
    .is('archived_at', null)
    .order('full_name', { ascending: true })
    .limit(8);

  const filter = customerSearchFilter(search);
  if (filter) request = request.or(filter);

  const { data, error } = await request;
  if (error) return [];
  return (data ?? []) as CustomerOption[];
}

/**
 * Same validation and duplicate-phone rule as `createCustomerAction`, minus
 * the redirect — the OCR review flow creates the guest and stays on the same
 * page to show the confirmation step next.
 */
export async function createCustomerInlineAction(input: {
  fullName: string;
  phone: string;
}): Promise<{ id: string | null; errorKey: string | null; duplicate?: DuplicateHint }> {
  const context = await getBusinessContext();
  if (!context) return { id: null, errorKey: 'error.unauthorized' };
  try {
    requirePermission(context, 'customers.manage');
  } catch {
    return { id: null, errorKey: 'error.unauthorized' };
  }

  const parsed = customerSchema.safeParse({
    fullName: input.fullName,
    phone: input.phone,
    phoneSecondary: '',
    email: '',
    facebookName: '',
    facebookUrl: '',
    telegramUsername: '',
    preferredLanguage: 'en',
    address: '',
    note: '',
  });
  if (!parsed.success) return { id: null, errorKey: 'error.generic' };

  const existing = await findCustomerByPhone(context, parsed.data.phone);
  if (existing) {
    return {
      id: null,
      errorKey: 'customer.duplicate.error',
      duplicate: { id: existing.id, name: existing.full_name, phone: existing.phone },
    };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('customers')
    .insert({
      business_id: context.business_id,
      full_name: parsed.data.fullName,
      phone: parsed.data.phone,
      phone_secondary: parsed.data.phoneSecondary,
      email: parsed.data.email,
      facebook_name: parsed.data.facebookName,
      facebook_url: parsed.data.facebookUrl,
      telegram_username: parsed.data.telegramUsername,
      preferred_language: parsed.data.preferredLanguage,
      address: parsed.data.address,
      note: parsed.data.note,
      created_by: user?.id ?? null,
    })
    .select('id')
    .maybeSingle();
  if (error) return { id: null, errorKey: writeError(error).messageKey ?? 'error.generic' };

  revalidatePath('/guests');
  return { id: (data as { id: string } | null)?.id ?? null, errorKey: null };
}

/** "Remove" in the UI. Archived, not deleted — there is no DELETE grant. */
export async function archiveCustomerNoteAction(formData: FormData): Promise<void> {
  const context = await getBusinessContext();
  if (!context) return;
  requirePermission(context, 'customers.notes.manage');

  const customerId = String(formData.get('customerId') ?? '');
  const supabase = await createSupabaseServerClient();
  await supabase
    .from('customer_notes')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', String(formData.get('noteId') ?? ''))
    .eq('business_id', context.business_id);

  revalidatePath(`/guests/${customerId}`);
}

// --- CSV import -------------------------------------------------------------

export interface ImportPreviewRow {
  index: number;
  values: Record<string, string>;
  /** i18n key of the first validation failure, or null when the row is fine. */
  errorKey: string | null;
  duplicateInDatabase: boolean;
}

/**
 * Validates the parsed file and tells the wizard which rows already exist.
 * The database lookup has to happen server-side; the rest is here so the two
 * apps can never disagree about what "valid" means.
 */
export async function reviewImportAction(rows: Record<string, string>[]): Promise<{
  status: 'ok' | 'error';
  messageKey?: string;
  rows: ImportPreviewRow[];
}> {
  const context = await getBusinessContext();
  if (!context) return { status: 'error', messageKey: 'error.unauthorized', rows: [] };
  requirePermission(context, 'customers.import');

  if (rows.length === 0) return { status: 'error', messageKey: 'customer.import.empty', rows: [] };
  if (rows.length > CUSTOMER_IMPORT_MAX_ROWS)
    return { status: 'error', messageKey: 'customer.import.tooMany', rows: [] };

  const known = new Set(
    await existingPhones(
      context,
      rows.map((row) => row.phone ?? ''),
    ),
  );

  return {
    status: 'ok',
    rows: rows.map((values, index) => {
      const parsed = customerImportRowSchema.safeParse(values);
      const errorKey = parsed.success ? null : (parsed.error.issues[0]?.message ?? 'error.generic');
      return {
        index,
        values,
        errorKey,
        duplicateInDatabase: parsed.success && known.has(parsed.data.phone),
      };
    }),
  };
}

export interface ImportSummary {
  status: 'ok' | 'error';
  messageKey?: string;
  imported: number;
  duplicate: number;
  invalid: number;
  /** Rows the user chose not to send. */
  skipped: number;
}

export async function importCustomersAction(
  rows: Record<string, string>[],
  skipped: number,
): Promise<ImportSummary> {
  const empty = { imported: 0, duplicate: 0, invalid: 0, skipped };

  const context = await getBusinessContext();
  if (!context) return { status: 'error', messageKey: 'error.unauthorized', ...empty };
  requirePermission(context, 'customers.import');

  if (rows.length === 0) return { status: 'error', messageKey: 'customer.import.empty', ...empty };
  if (rows.length > CUSTOMER_IMPORT_MAX_ROWS)
    return { status: 'error', messageKey: 'customer.import.tooMany', ...empty };

  const supabase = await createSupabaseServerClient();
  // The business id is the one the database just told us the caller belongs to,
  // and import_customers checks the permission again before the first insert.
  const { data, error } = await supabase.rpc('import_customers', {
    p_business_id: context.business_id,
    p_rows: rows,
  });
  if (error) return { status: 'error', messageKey: 'error.generic', ...empty };

  // Every row reports its own outcome, so nothing is dropped silently.
  const results = (data ?? []) as CustomerImportResult[];
  revalidatePath('/guests');
  return {
    status: 'ok',
    messageKey: 'customer.import.done',
    imported: results.filter((row) => row.status === 'imported').length,
    duplicate: results.filter((row) => row.status === 'duplicate').length,
    invalid: results.filter((row) => row.status === 'invalid').length,
    skipped,
  };
}
