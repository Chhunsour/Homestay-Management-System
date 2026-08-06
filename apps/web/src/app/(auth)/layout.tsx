import { createTranslator } from '@homestay/shared';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { getLocale } from '@/lib/i18n';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(22rem,0.82fr)_minmax(30rem,1.18fr)]">
      <section className="auth-atmosphere relative hidden overflow-hidden p-10 text-white lg:flex lg:flex-col lg:justify-between xl:p-14">
        <div className="relative z-10 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-white font-display text-xl font-semibold text-brand-900">
            H
          </span>
          <span className="font-display text-2xl font-semibold">{t('app.name')}</span>
        </div>
        <div className="relative z-10 max-w-md">
          <span className="mb-5 block h-1 w-12 rounded-full bg-accent-500" />
          <p className="font-display text-4xl leading-[1.08] tracking-[-0.025em] xl:text-5xl">
            {t('app.tagline')}
          </p>
        </div>
      </section>

      <div className="flex min-w-0 flex-col">
        <header className="flex items-center justify-between px-5 py-4 sm:px-8">
          <span className="font-display text-xl font-semibold text-slate-900 lg:hidden">
            {t('app.name')}
          </span>
          <span className="hidden lg:block" />
          <LanguageSwitcher locale={locale} />
        </header>

        <main
          id="main"
          className="flex flex-1 items-start justify-center px-5 pb-16 pt-8 sm:px-8 lg:items-center lg:py-14"
        >
          <div className="w-full max-w-md">{children}</div>
        </main>
      </div>
    </div>
  );
}
