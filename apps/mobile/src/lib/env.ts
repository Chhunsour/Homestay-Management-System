import { parseAuthProviders, type AuthProvider } from '@homestay/shared';

// Expo inlines EXPO_PUBLIC_* at build time, so these must be read literally.
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const siteUrl = process.env.EXPO_PUBLIC_SITE_URL;
const providers = parseAuthProviders(process.env.EXPO_PUBLIC_AUTH_PROVIDERS);

function required(value: string | undefined, name: string): string {
  if (!value)
    throw new Error(`Missing ${name}. Copy .env.example to .env — see docs/SUPABASE_SETUP.md.`);
  return value;
}

export const env = {
  get supabaseUrl(): string {
    return required(supabaseUrl, 'EXPO_PUBLIC_SUPABASE_URL');
  },
  get supabaseAnonKey(): string {
    return required(supabaseAnonKey, 'EXPO_PUBLIC_SUPABASE_ANON_KEY');
  },
  /** Web origin — password resets are completed there, not in the app. */
  get siteUrl(): string {
    return required(siteUrl, 'EXPO_PUBLIC_SITE_URL');
  },
  get authProviders(): readonly AuthProvider[] {
    return providers;
  },
};

export function isProviderEnabled(provider: string): provider is AuthProvider {
  return providers.includes(provider as AuthProvider);
}
