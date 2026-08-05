import { SignInForm } from '@/components/AuthForms';
import { env } from '@/lib/env';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // The Server Action re-validates this before redirecting; see safeNext().
  return <SignInForm next={next ?? '/dashboard'} providers={env.authProviders} />;
}
