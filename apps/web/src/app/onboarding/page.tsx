import { redirect } from 'next/navigation';
import { createTranslator } from '@homestay/shared';
import { OnboardingForm } from '@/components/OnboardingForm';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { SignOutButton } from '@/components/SignOutButton';
import { getBusinessContext } from '@/lib/business';
import { getLocale } from '@/lib/i18n';
import { getSessionUser } from '@/lib/supabase/server';

export default async function OnboardingPage() {
  const user = await getSessionUser();
  if (!user) redirect('/sign-in');

  // Already onboarded — nothing to do here.
  if (await getBusinessContext()) redirect('/dashboard');

  const locale = await getLocale();
  const t = createTranslator(locale);
  const fullName = user.user_metadata?.full_name;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-5 py-4">
        <span className="text-sm font-semibold tracking-tight text-slate-900">{t('app.name')}</span>
        <div className="flex items-center gap-3">
          <LanguageSwitcher locale={locale} />
          <SignOutButton locale={locale} variant="ghost" />
        </div>
      </header>

      <main id="main" className="flex flex-1 items-start justify-center px-5 pb-16 pt-6">
        <div className="w-full max-w-md">
          <OnboardingForm defaultName={typeof fullName === 'string' ? fullName : ''} />
        </div>
      </main>
    </div>
  );
}
