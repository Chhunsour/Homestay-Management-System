import { redirect } from 'next/navigation';
import { ResetPasswordForm } from '@/components/AuthForms';
import { getSessionUser } from '@/lib/supabase/server';

/**
 * Reached through the emailed recovery link, which /auth/callback exchanges for
 * a session first. Without that session there is nothing to update.
 */
export default async function ResetPasswordPage() {
  const user = await getSessionUser();
  if (!user) redirect('/forgot-password');

  return <ResetPasswordForm />;
}
