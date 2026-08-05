import { cookies } from 'next/headers';
import {
  LOCALE_STORAGE_KEY,
  createTranslator,
  resolveLocale,
  type Locale,
  type Translator,
} from '@homestay/shared';

/** Server-side locale: the cookie is the fast path, mirrored from the DB on sign-in. */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  return resolveLocale(store.get(LOCALE_STORAGE_KEY)?.value);
}

export async function getTranslator(): Promise<{ locale: Locale; t: Translator }> {
  const locale = await getLocale();
  return { locale, t: createTranslator(locale) };
}
