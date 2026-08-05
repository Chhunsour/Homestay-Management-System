import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import { env } from '@/lib/env';
import { safeStorage } from '@/lib/storage';

/**
 * Sessions live in safeStorage, which is what makes them survive an app
 * restart. `detectSessionInUrl` is a browser concept and must stay off here.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    storage: safeStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

// Refresh timers only make sense while the app is in the foreground.
AppState.addEventListener('change', (state) => {
  if (state === 'active') void supabase.auth.startAutoRefresh();
  else void supabase.auth.stopAutoRefresh();
});
