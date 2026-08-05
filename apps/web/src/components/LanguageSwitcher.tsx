import { LOCALES, createTranslator, type Locale } from '@homestay/shared';
import { setLanguageAction } from '@/lib/actions/business';
import { cx } from '@/components/ui';

const LABEL_KEYS = { en: 'common.english', km: 'common.khmer' } as const;

/**
 * Plain form + Server Action, so switching language works without any client
 * JavaScript. Rendered on the auth screens and in Settings.
 */
export function LanguageSwitcher({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);

  return (
    <form action={setLanguageAction}>
      <fieldset className="flex items-center gap-1">
        <legend className="sr-only">{t('common.language')}</legend>
        {LOCALES.map((option) => {
          const active = option === locale;
          return (
            <button
              key={option}
              type="submit"
              name="language"
              value={option}
              aria-pressed={active}
              lang={option}
              className={cx(
                'rounded-sm px-2.5 py-1 text-sm font-medium transition-colors',
                active
                  ? 'bg-brand-700 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
              )}
            >
              {t(LABEL_KEYS[option])}
            </button>
          );
        })}
      </fieldset>
    </form>
  );
}
