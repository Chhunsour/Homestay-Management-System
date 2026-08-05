'use client';

import { createBrowserClient } from '@supabase/ssr';
import { env } from '@/lib/env';

/**
 * Only needed for flows that must run in the browser (OAuth redirect handling
 * and the password-recovery hash). Everything else goes through Server Actions.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(env.supabaseUrl, env.supabaseAnonKey);
}
