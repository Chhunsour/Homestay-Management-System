import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createTranslator } from '@homestay/shared';
import { VerifyPhoneForm } from '@/components/AuthForms';
import { getLocale } from '@/lib/i18n';
import { Alert } from '@/components/ui';

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string; email?: string }>;
}) {
  const { phone, email } = await searchParams;

  if (phone) return <VerifyPhoneForm phone={phone} />;
  if (!email) redirect('/sign-in');

  // Email confirmation happens in the emailed link, so there is nothing to type here.
  const t = createTranslator(await getLocale());
  return (
    <div className="panel space-y-4 p-6">
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">
        {t('auth.verify.title')}
      </h1>
      <Alert tone="info">{t('auth.verify.subtitleEmail', { target: email })}</Alert>
      <Link
        href="/sign-in"
        className="inline-block text-sm text-brand-700 underline underline-offset-2"
      >
        {t('common.back')}
      </Link>
    </div>
  );
}
