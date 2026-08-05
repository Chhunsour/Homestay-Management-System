import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';

/**
 * Request-scoped Supabase client. Reads the session from cookies, so it must be
 * created per request — never cached at module scope.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // The middleware already refreshes the session, so this is safe.
        }
      },
    },
  });
}

/** The signed-in user, or null. Verified against the auth server, not decoded locally. */
export async function getSessionUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
