'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import type { AuthProvider, TranslationKey } from '@homestay/shared';
import {
  requestPasswordResetAction,
  resendPhoneOtpAction,
  sendPhoneOtpAction,
  signInWithPasswordAction,
  signUpWithPasswordAction,
  updatePasswordAction,
  verifyPhoneOtpAction,
} from '@/lib/actions/auth';
import { IDLE, type ActionState } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { OAuthButtons } from '@/components/OAuthButtons';
import { SubmitButton } from '@/components/SubmitButton';
import { Alert, Field, TextInput, cx } from '@/components/ui';

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                 */
/* -------------------------------------------------------------------------- */

/** Field errors travel as i18n keys, so the client decides the language. */
function useFieldError(state: ActionState) {
  const { t } = useT();
  return (field: string): string | undefined => {
    const key = state.fieldErrors?.[field];
    return key ? t(key as TranslationKey) : undefined;
  };
}

function StateAlert({ state }: { state: ActionState }) {
  const { t } = useT();
  if (!state.messageKey || state.status === 'idle') return null;
  // A field-level error is already shown next to the input; don't repeat it.
  if (state.status === 'error' && state.fieldErrors) return null;
  return <Alert tone={state.status === 'error' ? 'error' : 'success'}>{t(state.messageKey)}</Alert>;
}

function Heading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
      {subtitle ? <p className="mt-1 text-sm text-slate-600">{subtitle}</p> : null}
    </div>
  );
}

function FooterLink({ prompt, href, label }: { prompt: string; href: string; label: string }) {
  return (
    <p className="mt-6 text-center text-sm text-slate-600">
      {prompt}{' '}
      <Link href={href} className="font-medium text-brand-700 underline underline-offset-2">
        {label}
      </Link>
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Sign in                                                                     */
/* -------------------------------------------------------------------------- */

export function SignInForm({
  next,
  providers,
}: {
  next: string;
  providers: readonly AuthProvider[];
}) {
  const { t } = useT();
  const phoneEnabled = providers.includes('phone');
  const [method, setMethod] = useState<'email' | 'phone'>('email');

  const [pwState, pwAction] = useActionState(signInWithPasswordAction, IDLE);
  const [otpState, otpAction] = useActionState(sendPhoneOtpAction, IDLE);
  const state = method === 'email' ? pwState : otpState;
  const errorFor = useFieldError(state);

  return (
    <div className="panel p-6">
      <Heading title={t('auth.signIn.title')} subtitle={t('auth.signIn.subtitle')} />

      {phoneEnabled ? (
        <div role="tablist" aria-label={t('auth.signIn.title')} className="mb-5 flex gap-1">
          {(['email', 'phone'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={method === option}
              onClick={() => setMethod(option)}
              className={cx(
                'flex-1 rounded-sm border px-3 py-1.5 text-sm font-medium',
                method === option
                  ? 'border-brand-600 bg-brand-50 text-brand-800'
                  : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              {t(option === 'email' ? 'auth.method.email' : 'auth.method.phone')}
            </button>
          ))}
        </div>
      ) : null}

      <div className="space-y-4">
        <StateAlert state={state} />

        {method === 'email' ? (
          <form action={pwAction} className="space-y-4">
            <input type="hidden" name="next" value={next} />
            <Field id="email" label={t('auth.field.email')} error={errorFor('email')}>
              <TextInput
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                invalid={Boolean(errorFor('email'))}
              />
            </Field>
            <Field id="password" label={t('auth.field.password')} error={errorFor('password')}>
              <TextInput
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                invalid={Boolean(errorFor('password'))}
              />
            </Field>
            <SubmitButton labelKey="auth.signIn.submit" className="w-full" />
          </form>
        ) : (
          <form action={otpAction} className="space-y-4">
            <Field
              id="phone"
              label={t('auth.field.phone')}
              hint={t('validation.phone')}
              error={errorFor('phone')}
            >
              <TextInput
                id="phone"
                name="phone"
                type="tel"
                autoComplete="tel"
                placeholder="+85512345678"
                required
                invalid={Boolean(errorFor('phone'))}
              />
            </Field>
            <SubmitButton labelKey="auth.sendCode" className="w-full" />
          </form>
        )}

        <p className="text-sm">
          <Link
            href="/forgot-password"
            className="text-slate-600 underline underline-offset-2 hover:text-slate-900"
          >
            {t('auth.forgot.link')}
          </Link>
        </p>

        <OAuthButtons providers={providers} next={next} />
      </div>

      <FooterLink
        prompt={t('auth.signIn.noAccount')}
        href="/sign-up"
        label={t('auth.signIn.createOne')}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sign up                                                                     */
/* -------------------------------------------------------------------------- */

export function SignUpForm({ providers }: { providers: readonly AuthProvider[] }) {
  const { t } = useT();
  const [state, action] = useActionState(signUpWithPasswordAction, IDLE);
  const errorFor = useFieldError(state);

  return (
    <div className="panel p-6">
      <Heading title={t('auth.signUp.title')} subtitle={t('auth.signUp.subtitle')} />

      <div className="space-y-4">
        <StateAlert state={state} />

        <form action={action} className="space-y-4">
          <Field id="fullName" label={t('auth.field.fullName')} error={errorFor('fullName')}>
            <TextInput
              id="fullName"
              name="fullName"
              autoComplete="name"
              required
              invalid={Boolean(errorFor('fullName'))}
            />
          </Field>
          <Field id="email" label={t('auth.field.email')} error={errorFor('email')}>
            <TextInput
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              invalid={Boolean(errorFor('email'))}
            />
          </Field>
          <Field
            id="password"
            label={t('auth.field.password')}
            hint={t('validation.password.min')}
            error={errorFor('password')}
          >
            <TextInput
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              invalid={Boolean(errorFor('password'))}
            />
          </Field>
          <Field
            id="confirmPassword"
            label={t('auth.field.confirmPassword')}
            error={errorFor('confirmPassword')}
          >
            <TextInput
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              invalid={Boolean(errorFor('confirmPassword'))}
            />
          </Field>
          <SubmitButton labelKey="auth.signUp.submit" className="w-full" />
        </form>

        <OAuthButtons providers={providers} next="/onboarding" />
      </div>

      <FooterLink
        prompt={t('auth.signUp.haveAccount')}
        href="/sign-in"
        label={t('auth.signUp.signIn')}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Forgot / reset password                                                     */
/* -------------------------------------------------------------------------- */

export function ForgotPasswordForm() {
  const { t } = useT();
  const [state, action] = useActionState(requestPasswordResetAction, IDLE);
  const errorFor = useFieldError(state);

  return (
    <div className="panel p-6">
      <Heading title={t('auth.forgot.title')} subtitle={t('auth.forgot.subtitle')} />

      <div className="space-y-4">
        <StateAlert state={state} />
        <form action={action} className="space-y-4">
          <Field id="email" label={t('auth.field.email')} error={errorFor('email')}>
            <TextInput
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              invalid={Boolean(errorFor('email'))}
            />
          </Field>
          <SubmitButton labelKey="auth.forgot.submit" className="w-full" />
        </form>
      </div>

      <FooterLink prompt="" href="/sign-in" label={t('common.back')} />
    </div>
  );
}

export function ResetPasswordForm() {
  const { t } = useT();
  const [state, action] = useActionState(updatePasswordAction, IDLE);
  const errorFor = useFieldError(state);

  return (
    <div className="panel p-6">
      <Heading title={t('auth.reset.title')} />

      <div className="space-y-4">
        <StateAlert state={state} />
        <form action={action} className="space-y-4">
          <Field
            id="password"
            label={t('auth.field.password')}
            hint={t('validation.password.min')}
            error={errorFor('password')}
          >
            <TextInput
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              invalid={Boolean(errorFor('password'))}
            />
          </Field>
          <Field
            id="confirmPassword"
            label={t('auth.field.confirmPassword')}
            error={errorFor('confirmPassword')}
          >
            <TextInput
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              invalid={Boolean(errorFor('confirmPassword'))}
            />
          </Field>
          <SubmitButton labelKey="auth.reset.submit" className="w-full" />
        </form>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Verify phone                                                                */
/* -------------------------------------------------------------------------- */

export function VerifyPhoneForm({ phone }: { phone: string }) {
  const { t } = useT();
  const [state, action] = useActionState(verifyPhoneOtpAction, IDLE);
  const [resendState, resendAction] = useActionState(resendPhoneOtpAction, IDLE);
  const errorFor = useFieldError(state);

  return (
    <div className="panel p-6">
      <Heading
        title={t('auth.verify.title')}
        subtitle={t('auth.verify.subtitlePhone', { target: phone })}
      />

      <div className="space-y-4">
        <StateAlert state={state} />
        <StateAlert state={resendState} />

        <form action={action} className="space-y-4">
          <input type="hidden" name="phone" value={phone} />
          <Field id="token" label={t('auth.field.code')} error={errorFor('token')}>
            <TextInput
              id="token"
              name="token"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              invalid={Boolean(errorFor('token'))}
            />
          </Field>
          <SubmitButton labelKey="auth.verify.submit" className="w-full" />
        </form>

        <form action={resendAction}>
          <input type="hidden" name="phone" value={phone} />
          <SubmitButton labelKey="auth.verify.resend" variant="ghost" className="w-full" />
        </form>
      </div>
    </div>
  );
}
