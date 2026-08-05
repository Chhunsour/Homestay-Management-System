import { createTranslator, type TranslationKey } from '@homestay/shared';
import { EmptyState, PageHeader } from '@/components/ui';
import { getLocale } from '@/lib/i18n';

/** Shared body for the Phase 2 sections that only need polished navigation. */
export async function Placeholder({ sectionKey }: { sectionKey: TranslationKey }) {
  const t = createTranslator(await getLocale());
  const section = t(sectionKey);

  return (
    <>
      <PageHeader title={section} />
      <EmptyState title={t('placeholder.title')} body={t('placeholder.body', { section })} />
    </>
  );
}
