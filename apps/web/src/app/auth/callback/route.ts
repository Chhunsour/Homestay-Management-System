import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Landing point for OAuth sign-in, email confirmation and password recovery
 * links. Exchanges the one-time code for a cookie session, then forwards.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const raw = searchParams.get('next') ?? '/dashboard';
  const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/dashboard';

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(`${origin}/sign-in`);
}
