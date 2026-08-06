'use client';

import { useActionState } from 'react';
import type { AuthProvider } from '@homestay/shared';
import { signInWithProviderAction } from '@/lib/actions/auth';
import { IDLE } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { Alert, buttonStyles } from '@/components/ui';

const LABEL_KEYS = { google: 'auth.google', apple: 'auth.apple' } as const;

export function OAuthButtons({
  providers,
  next,
}: {
  providers: readonly AuthProvider[];
  next: string;
}) {
  const { t } = useT();
  const [state, action, pending] = useActionState(signInWithProviderAction, IDLE);

  const enabled = providers.filter(
    (provider): provider is 'google' | 'apple' => provider === 'google' || provider === 'apple',
  );
  if (enabled.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-slate-200" />
        <span className="text-xs uppercase tracking-wide text-slate-600">{t('common.or')}</span>
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      {state.status === 'error' && state.messageKey ? (
        <Alert tone="error">{t(state.messageKey)}</Alert>
      ) : null}

      <div className="space-y-2">
        {enabled.map((provider) => (
          <form key={provider} action={action}>
            <input type="hidden" name="provider" value={provider} />
            <input type="hidden" name="next" value={next} />
            <button
              type="submit"
              disabled={pending}
              className={`${buttonStyles('secondary')} w-full`}
            >
              {t(LABEL_KEYS[provider])}
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}
