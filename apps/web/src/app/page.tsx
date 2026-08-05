import { redirect } from 'next/navigation';

/** Middleware bounces unauthenticated visitors to /sign-in from here. */
export default function IndexPage() {
  redirect('/dashboard');
}
