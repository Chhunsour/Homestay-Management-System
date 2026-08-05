'use client';

import { useFormStatus } from 'react-dom';
import type { TranslationKey } from '@homestay/shared';
import { useT } from '@/components/LocaleProvider';
import { Button } from '@/components/ui';

/**
 * Must be rendered inside the <form> it submits — useFormStatus reads the
 * nearest form's pending state.
 */
export function SubmitButton({
  labelKey,
  variant = 'primary',
  className,
}: {
  labelKey: TranslationKey;
  variant?: 'primary' | 'secondary' | 'ghost';
  className?: string;
}) {
  const { pending } = useFormStatus();
  const { t } = useT();

  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending}
      aria-busy={pending}
      className={className}
    >
      {pending ? t('common.loading') : t(labelKey)}
    </Button>
  );
}
