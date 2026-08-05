import { createTranslator, type Locale } from '@homestay/shared';
import { signOutAction } from '@/lib/actions/auth';
import { buttonStyles } from '@/components/ui';

export function SignOutButton({
  locale,
  variant = 'secondary',
}: {
  locale: Locale;
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  const t = createTranslator(locale);

  return (
    <form action={signOutAction}>
      <button type="submit" className={buttonStyles(variant)}>
        {t('common.signOut')}
      </button>
    </form>
  );
}
