import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { can, createTranslator, formatDate } from '@homestay/shared';
import { CustomerNotes } from '@/components/customers/CustomerNotes';
import { CustomerStatusActions } from '@/components/customers/CustomerStatusActions';
import { Badge, DataRow, PageHeader, Panel, buttonStyles } from '@/components/ui';
import { getActiveMembers, getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { getCustomer, listCustomerNotes } from '@/lib/customers';

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const { id } = await params;
  const customer = await getCustomer(context, id);
  if (!customer) notFound();

  const locale = await getLocale();
  const t = createTranslator(locale);
  const notes = await listCustomerNotes(context, id);

  // Names only when the caller may read the member list; otherwise the note
  // still shows, just without an author.
  const members = await getActiveMembers(context);
  const authors: Record<string, string> = {};
  for (const member of members ?? []) {
    if (member.full_name) authors[member.user_id] = member.full_name;
  }

  const canManage = can(context.role, 'customers.manage');
  const archived = customer.archived_at !== null;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title={customer.full_name} description={customer.phone} />
        <div className="flex flex-wrap items-center gap-2">
          {canManage && !archived ? (
            <Link href={`/guests/${customer.id}/edit`} className={buttonStyles('secondary')}>
              {t('common.edit')}
            </Link>
          ) : null}
          {can(context.role, 'customers.archive') ? (
            <CustomerStatusActions customerId={customer.id} archived={archived} />
          ) : null}
        </div>
      </div>

      {archived ? (
        <p className="mb-5 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t('customer.archivedNotice')}
        </p>
      ) : null}

      <div className="space-y-6">
        <Panel>
          <div className="flex items-center justify-between gap-2 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">
              {t('customer.section.contact')}
            </h2>
            <Badge>{archived ? t('customer.status.archived') : t('customer.status.active')}</Badge>
          </div>
          <dl className="border-t border-slate-100">
            <DataRow
              label={t('customer.field.phone')}
              value={
                <a href={`tel:${customer.normalized_phone}`} className="hover:underline">
                  {customer.phone}
                </a>
              }
            />
            <DataRow
              label={t('customer.field.phoneSecondary')}
              value={customer.phone_secondary || t('common.notSet')}
            />
            <DataRow
              label={t('customer.field.email')}
              value={customer.email || t('common.notSet')}
            />
            <DataRow
              label={t('customer.field.facebookName')}
              value={customer.facebook_name || t('common.notSet')}
            />
            <DataRow
              label={t('customer.field.facebookUrl')}
              value={customer.facebook_url || t('common.notSet')}
            />
            <DataRow
              label={t('customer.field.telegram')}
              value={
                customer.telegram_username ? `@${customer.telegram_username}` : t('common.notSet')
              }
            />
            <DataRow
              label={t('customer.field.language')}
              value={customer.preferred_language === 'km' ? t('common.khmer') : t('common.english')}
            />
            <DataRow
              label={t('customer.field.address')}
              value={customer.address || t('common.notSet')}
            />
            <DataRow label={t('customer.field.note')} value={customer.note || t('common.notSet')} />
            <DataRow
              label={t('customer.field.created')}
              value={formatDate(locale, customer.created_at, context.timezone)}
            />
          </dl>
        </Panel>

        <Panel>
          <div className="px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('customer.notes.title')}</h2>
            <p className="mt-1 text-sm text-slate-600">{t('customer.notes.subtitle')}</p>
          </div>
          <CustomerNotes
            customerId={customer.id}
            notes={notes}
            authors={authors}
            timezone={context.timezone}
            canAdd={canManage && !archived}
            canRemove={can(context.role, 'customers.notes.manage')}
          />
        </Panel>

        <Panel>
          <div className="px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">{t('customer.history.title')}</h2>
          </div>
          {/* Real bookings and payments arrive in a later phase. Placeholder
              rows would only teach staff to distrust the screen. */}
          <div className="border-t border-slate-100 px-5 py-10 text-center">
            <p className="text-sm font-medium text-slate-900">{t('customer.history.empty')}</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">
              {t('customer.history.body')}
            </p>
          </div>
        </Panel>
      </div>
    </>
  );
}
