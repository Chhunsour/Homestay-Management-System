import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';

/** Reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = [
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/reset-password',
  '/verify',
  '/auth',
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** Next 16 calls this "proxy"; it is the old middleware convention, renamed. */
export default async function proxy(request: NextRequest) {
  // Mutable so the Supabase client can rewrite it when it rotates the session.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() (not getSession()) — it revalidates the token with the auth server
  // and refreshes it, which is what keeps sessions restored across reloads.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublic(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = '';
    // Only ever a same-origin path, so this cannot be turned into an open redirect.
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  // A signed-in user has no business on the auth screens. /reset-password is the
  // exception: the recovery link signs you in before you choose a new password.
  if (
    user &&
    isPublic(pathname) &&
    !pathname.startsWith('/auth') &&
    pathname !== '/reset-password'
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
