'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import {
  LOCALE_STORAGE_KEY,
  fieldErrors,
  forgotPasswordSchema,
  phoneSignInSchema,
  resetPasswordSchema,
  signInWithPasswordSchema,
  signUpSchema,
  verifyOtpSchema,
  type AuthProvider,
} from '@homestay/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { env, isProviderEnabled } from '@/lib/env';
import { failure, mapAuthError, success, type ActionState } from '@/lib/actions/state';
import { getLocale } from '@/lib/i18n';

/** Refuses anything that is not a same-origin path, so ?next= cannot redirect off-site. */
function safeNext(value: FormDataEntryValue | null): string {
  const raw = typeof value === 'string' ? value : '';
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/dashboard';
}

export async function signInWithPasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = signInWithPasswordSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return failure(mapAuthError(error));

  redirect(safeNext(formData.get('next')));
}

export async function signUpWithPasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = signUpSchema.safeParse({
    fullName: formData.get('fullName'),
    email: formData.get('email'),
    password: formData.get('password'),
    confirmPassword: formData.get('confirmPassword'),
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const locale = await getLocale();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // Consumed by the handle_new_user() trigger to seed profile + preferences.
      data: { full_name: parsed.data.fullName, language: locale },
      emailRedirectTo: `${env.siteUrl}/auth/callback?next=/onboarding`,
    },
  });
  if (error) return failure(mapAuthError(error));

  // Email confirmations off → we already have a session; go straight to onboarding.
  if (data.session) redirect('/onboarding');

  return success('auth.signUp.checkEmail');
}

export async function sendPhoneOtpAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = phoneSignInSchema.safeParse({ phone: formData.get('phone') });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({ phone: parsed.data.phone });
  if (error) return failure(mapAuthError(error));

  redirect(`/verify?phone=${encodeURIComponent(parsed.data.phone)}`);
}

export async function verifyPhoneOtpAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const phone = phoneSignInSchema.safeParse({ phone: formData.get('phone') });
  const token = verifyOtpSchema.safeParse({ token: formData.get('token') });

  if (!phone.success) return failure('error.generic', fieldErrors(phone.error));
  if (!token.success) return failure('error.generic', fieldErrors(token.error));

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({
    phone: phone.data.phone,
    token: token.data.token,
    type: 'sms',
  });
  if (error) return failure(mapAuthError(error));

  redirect('/dashboard');
}

export async function resendPhoneOtpAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = phoneSignInSchema.safeParse({ phone: formData.get('phone') });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({ phone: parsed.data.phone });
  if (error) return failure(mapAuthError(error));

  return success('auth.verify.resent');
}

export async function requestPasswordResetAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = forgotPasswordSchema.safeParse({ email: formData.get('email') });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${env.siteUrl}/auth/callback?next=/reset-password`,
  });

  // Rate limits are worth surfacing; anything else stays vague so this endpoint
  // cannot be used to discover which addresses have accounts.
  if (error && error.status === 429) return failure('auth.error.rateLimit');

  return success('auth.forgot.sent');
}

export async function updatePasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = resetPasswordSchema.safeParse({
    password: formData.get('password'),
    confirmPassword: formData.get('confirmPassword'),
  });
  if (!parsed.success) return failure('error.generic', fieldErrors(parsed.error));

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return failure('error.unauthorized');

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return failure(mapAuthError(error));

  redirect('/dashboard');
}

export async function signInWithProviderAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const provider = String(formData.get('provider') ?? '');
  if (!isProviderEnabled(provider)) return failure('auth.error.providerDisabled');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: provider as Extract<AuthProvider, 'google' | 'apple'>,
    options: {
      redirectTo: `${env.siteUrl}/auth/callback?next=${encodeURIComponent(safeNext(formData.get('next')))}`,
      skipBrowserRedirect: true,
    },
  });
  if (error || !data.url) return failure(error ? mapAuthError(error) : 'error.generic');

  redirect(data.url);
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  // Drop the language cookie too, so the next user on this browser starts clean.
  const store = await cookies();
  store.delete(LOCALE_STORAGE_KEY);

  redirect('/sign-in');
}
