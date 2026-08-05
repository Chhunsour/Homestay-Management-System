import { redirect } from 'next/navigation';
import { createTranslator } from '@homestay/shared';
import { Sidebar } from '@/components/Sidebar';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { SignOutButton } from '@/components/SignOutButton';
import { Badge } from '@/components/ui';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';

/**
 * Every signed-in screen hangs off this layout, so the "you must have a
 * business" rule is enforced once. Middleware has already required a session.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const context = await getBusinessContext();
  if (!context) redirect('/onboarding');

  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <div className="min-h-screen bg-canvas">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-sm focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        {t('nav.dashboard')}
      </a>

      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold tracking-tight text-slate-900">
            {context.business_name}
          </span>
          <Badge>{t(`role.${context.role}`)}</Badge>
        </div>
        <div className="flex items-center gap-3">
          <LanguageSwitcher locale={locale} />
          <SignOutButton locale={locale} variant="secondary" />
        </div>
      </header>

      <div className="md:flex">
        <aside className="border-b border-line bg-surface md:min-h-[calc(100vh-57px)] md:w-56 md:shrink-0 md:border-b-0 md:border-r">
          <Sidebar />
        </aside>

        <main id="main" className="min-w-0 flex-1 px-4 py-6 md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
