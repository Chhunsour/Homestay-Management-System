import { SignUpForm } from '@/components/AuthForms';
import { env } from '@/lib/env';

export default function SignUpPage() {
  return <SignUpForm providers={env.authProviders} />;
}
