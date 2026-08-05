import { createTranslator } from '@homestay/shared';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { getLocale } from '@/lib/i18n';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-5 py-4">
        <span className="text-sm font-semibold tracking-tight text-slate-900">{t('app.name')}</span>
        <LanguageSwitcher locale={locale} />
      </header>

      <main id="main" className="flex flex-1 items-start justify-center px-5 pb-16 pt-6">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
