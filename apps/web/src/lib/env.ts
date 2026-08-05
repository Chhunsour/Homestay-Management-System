import { parseAuthProviders } from '@homestay/shared';

/**
 * Next inlines `process.env.NEXT_PUBLIC_*` at build time only when it is
 * referenced literally, so these must not be read through a dynamic key.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to apps/web/.env.local and fill it in.`);
  }
  return value;
}

export const env = {
  get supabaseUrl() {
    return required(SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL');
  },
  get supabaseAnonKey() {
    return required(SUPABASE_ANON_KEY, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  },
  /** Absolute origin used for OAuth and email redirects. */
  get siteUrl() {
    return (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  },
  get authProviders() {
    return parseAuthProviders(process.env.NEXT_PUBLIC_AUTH_PROVIDERS);
  },
};

export function isProviderEnabled(provider: string): boolean {
  return (env.authProviders as readonly string[]).includes(provider);
}
