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
    <div className="min-h-dvh bg-canvas md:grid md:grid-cols-[17rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-sm focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        {t('nav.dashboard')}
      </a>

      <aside className="border-b border-line bg-surface/95 md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:border-r md:border-b-0">
        <header className="px-4 py-4 md:block md:px-5 md:pb-5 md:pt-6">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-900 font-display text-xl font-semibold text-white shadow-sm"
            >
              H
            </span>
            <div className="min-w-0">
              <p className="font-display text-lg font-semibold leading-tight text-slate-900">
                {t('app.name')}
              </p>
              <p className="truncate text-xs text-slate-500">{context.business_name}</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 pt-4 md:flex">
            <Badge>{t(`role.${context.role}`)}</Badge>
          </div>
          <div className="mt-3 flex w-full items-center justify-between gap-3 border-t border-line pt-3 md:hidden">
            <LanguageSwitcher locale={locale} />
            <SignOutButton locale={locale} variant="ghost" />
          </div>
        </header>

        <Sidebar />

        <footer className="mt-auto hidden border-t border-line p-4 md:block">
          <p className="mb-3 truncate px-1 text-xs font-medium text-slate-500">
            {context.business_name}
          </p>
          <div className="grid gap-2">
            <LanguageSwitcher locale={locale} />
            <SignOutButton locale={locale} variant="secondary" />
          </div>
        </footer>
      </aside>

      <div className="min-w-0">
        <main
          id="main"
          className="app-shell-main min-w-0 px-4 py-7 sm:px-6 md:px-8 md:py-10 xl:px-12"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
