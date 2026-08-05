import { can, createTranslator, formatDate, isCustomerFilter, toCsv } from '@homestay/shared';
import type { Customer } from '@homestay/shared';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * CSV download. Owners and managers only — `export_customers` re-checks that in
 * SQL, so hiding the button is not the control.
 *
 * A route handler rather than a Server Action because the response is a file.
 * Internal columns (ids, the normalised phone, audit fields) never leave here.
 */
export async function GET(request: Request): Promise<Response> {
  const context = await getBusinessContext();
  if (!context) return new Response(null, { status: 401 });
  if (!can(context.role, 'customers.export')) return new Response(null, { status: 403 });

  const url = new URL(request.url);
  const filterParam = url.searchParams.get('filter') ?? 'active';
  const filter = isCustomerFilter(filterParam) ? filterParam : 'active';
  const search = url.searchParams.get('q')?.trim() ?? '';

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('export_customers', {
    p_business_id: context.business_id,
    // null means "both", matching the All filter.
    p_archived: filter === 'all' ? null : filter === 'archived',
    p_search: search || null,
  });
  if (error) return new Response(null, { status: 403 });

  const locale = await getLocale();
  const t = createTranslator(locale);
  const customers = (data ?? []) as Customer[];

  const rows: string[][] = [
    [
      t('customer.field.fullName'),
      t('customer.field.phone'),
      t('customer.field.phoneSecondary'),
      t('customer.field.email'),
      t('customer.field.facebookName'),
      t('customer.field.facebookUrl'),
      t('customer.field.telegram'),
      t('customer.field.language'),
      t('customer.field.address'),
      t('customer.field.note'),
      t('customer.status.active'),
      t('customer.field.created'),
    ],
    ...customers.map((customer) => [
      customer.full_name,
      customer.phone,
      customer.phone_secondary ?? '',
      customer.email ?? '',
      customer.facebook_name ?? '',
      customer.facebook_url ?? '',
      customer.telegram_username ?? '',
      customer.preferred_language === 'km' ? t('common.khmer') : t('common.english'),
      customer.address ?? '',
      customer.note ?? '',
      customer.archived_at ? t('customer.status.archived') : t('customer.status.active'),
      formatDate(locale, customer.created_at, context.timezone),
    ]),
  ];

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(rows), {
    headers: {
      // toCsv writes a UTF-8 BOM so Excel opens Khmer text correctly.
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="customers-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
