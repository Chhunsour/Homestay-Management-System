import { redirect } from 'next/navigation';
import { createTranslator, formatDate } from '@homestay/shared';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { Badge, DataRow, PageHeader, Panel } from '@/components/ui';
import { getActiveMembers, getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { getSessionUser } from '@/lib/supabase/server';

export default async function SettingsPage() {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const locale = await getLocale();
  const t = createTranslator(locale);
  const user = await getSessionUser();
  // Returns null when the role lacks members.read — the database enforces the
  // same rule, this only decides what to render.
  const members = await getActiveMembers(context);

  return (
    <>
      <PageHeader title={t('settings.title')} />

      <div className="max-w-2xl space-y-6">
        <Panel className="p-5">
          <h2 className="text-sm font-semibold text-slate-900">{t('settings.language.title')}</h2>
          <p className="mt-1 text-sm text-slate-600">{t('settings.language.body')}</p>
          <div className="mt-3">
            <LanguageSwitcher locale={locale} />
          </div>
        </Panel>

        <Panel>
          <h2 className="px-5 py-3.5 text-sm font-semibold text-slate-900">
            {t('settings.business.title')}
          </h2>
          <dl className="border-t border-slate-100">
            <DataRow label={t('dashboard.business')} value={context.business_name} />
            <DataRow label={t('settings.business.currency')} value={context.default_currency} />
            <DataRow label={t('settings.business.timezone')} value={context.timezone} />
          </dl>
        </Panel>

        <Panel>
          <h2 className="px-5 py-3.5 text-sm font-semibold text-slate-900">
            {t('settings.account.title')}
          </h2>
          <dl className="border-t border-slate-100">
            <DataRow label={t('settings.account.email')} value={user?.email ?? '—'} />
            <DataRow label={t('settings.account.phone')} value={user?.phone || '—'} />
            <DataRow label={t('dashboard.role')} value={t(`role.${context.role}`)} />
            <DataRow
              label={t('settings.account.memberSince')}
              value={user ? formatDate(locale, user.created_at) : '—'}
            />
          </dl>
        </Panel>

        <Panel>
          <h2 className="px-5 py-3.5 text-sm font-semibold text-slate-900">
            {t('settings.team.title')}
          </h2>
          {members ? (
            <dl className="border-t border-slate-100">
              {members.map((member) => (
                <DataRow
                  key={member.user_id}
                  label={member.full_name ?? '—'}
                  value={<Badge>{t(`role.${member.role}`)}</Badge>}
                />
              ))}
            </dl>
          ) : (
            <p className="border-t border-slate-100 px-5 py-4 text-sm text-slate-600">
              {t('settings.team.restricted')}
            </p>
          )}
        </Panel>
      </div>
    </>
  );
}
