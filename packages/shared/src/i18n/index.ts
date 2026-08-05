import { DEFAULT_LOCALE, LOCALES, type Locale } from '../constants.ts';
import { en, type TranslationKey } from './en.ts';
import { km } from './km.ts';

export type { TranslationKey };

const DICTIONARIES: Record<Locale, Record<TranslationKey, string>> = { en, km };

export type TranslateVars = Record<string, string | number>;
export type Translator = (key: TranslationKey, vars?: TranslateVars) => string;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function translate(locale: Locale, key: TranslationKey, vars?: TranslateVars): string {
  const template = DICTIONARIES[locale][key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function createTranslator(locale: Locale): Translator {
  return (key, vars) => translate(locale, key, vars);
}

/** Locale tag suitable for `Intl` and the HTML `lang` attribute. */
export function intlLocale(locale: Locale): string {
  return locale === 'km' ? 'km-KH' : 'en-US';
}

export function formatDate(locale: Locale, value: string | Date, timeZone?: string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeZone,
  }).format(date);
}

/** Blocked dates are instants; always render them in the business time zone. */
export function formatDateTime(locale: Locale, value: string | Date, timeZone?: string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}

export function formatMoney(locale: Locale, amount: number | string, currency: string): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return '—';
  // Intl already knows KHR has no minor unit, so no per-currency table here.
  return new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency }).format(value);
}

/** `'14:00:00'` from postgres `time` -> `'14:00'` for an `<input type="time">`. */
export function toTimeInput(value: string | null | undefined): string {
  return (value ?? '').slice(0, 5);
}
