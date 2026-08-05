'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { DEFAULT_LOCALE, createTranslator, type Locale, type Translator } from '@homestay/shared';

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/**
 * Client-side translator. The dictionaries are plain data, so importing them
 * into the bundle costs a few KB and removes the need to thread strings through
 * props from every server component.
 */
export function useT(): { locale: Locale; t: Translator } {
  const locale = useContext(LocaleContext);
  const t = useMemo(() => createTranslator(locale), [locale]);
  return { locale, t };
}
