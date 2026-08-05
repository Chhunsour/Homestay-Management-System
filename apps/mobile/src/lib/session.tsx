import { safeStorage } from '@/lib/storage';
import type { User } from '@supabase/supabase-js';
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  createTranslator,
  resolveLocale,
  type BusinessContext,
  type Locale,
  type Translator,
} from '@homestay/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { supabase } from '@/lib/supabase';

interface SessionValue {
  /** False until the stored session (and, if signed in, the business) is known. */
  ready: boolean;
  user: User | null;
  business: BusinessContext | null;
  locale: Locale;
  t: Translator;
  setLocale: (locale: Locale) => Promise<void>;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [business, setBusiness] = useState<BusinessContext | null>(null);
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [sessionReady, setSessionReady] = useState(false);
  const [businessReady, setBusinessReady] = useState(false);

  // Session restoration: read whatever safeStorage kept from the last run.
  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const stored = await safeStorage.getItem(LOCALE_STORAGE_KEY);
        if (stored && active) setLocaleState(resolveLocale(stored));
        const { data } = await supabase.auth.getSession();
        if (active) setUser(data.session?.user ?? null);
      } catch (err) {
        console.warn('Failed to restore session:', err);
      } finally {
        if (active) setSessionReady(true);
      }
    })();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) {
        setUser(session?.user ?? null);
        setSessionReady(true);
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const loadBusiness = useCallback(async (): Promise<void> => {
    try {
      const { data, error } = await supabase.rpc('current_business_context');
      const rows = (error ? [] : ((data ?? []) as BusinessContext[])) as BusinessContext[];
      setBusiness(rows[0] ?? null);
    } catch (err) {
      console.warn('Failed to load business context:', err);
      setBusiness(null);
    } finally {
      setBusinessReady(true);
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setBusiness(null);
      setBusinessReady(false);
      return;
    }
    setBusinessReady(false);
    void loadBusiness();
  }, [user?.id, loadBusiness]);

  const setLocale = useCallback(
    async (next: Locale): Promise<void> => {
      setLocaleState(next);
      await safeStorage.setItem(LOCALE_STORAGE_KEY, next);
      // RLS limits this to the caller's own row; no user id is sent.
      if (user)
        await supabase.from('user_preferences').update({ language: next }).eq('user_id', user.id);
    },
    [user],
  );

  const value = useMemo<SessionValue>(
    () => ({
      ready: sessionReady && (!user || businessReady),
      user,
      business,
      locale,
      t: createTranslator(locale),
      setLocale,
      refresh: loadBusiness,
      signOut: async () => {
        await supabase.auth.signOut();
        await safeStorage.removeItem(LOCALE_STORAGE_KEY);
      },
    }),
    [sessionReady, businessReady, user, business, locale, setLocale, loadBusiness],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
