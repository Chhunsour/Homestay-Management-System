import type { TranslationKey } from '@homestay/shared';
import { Empty, Screen, Title } from '@/components/ui';
import { useSession } from '@/lib/session';

/** Shared body for the tabs that only become real in a later phase. */
export function PlaceholderScreen({ sectionKey }: { sectionKey: TranslationKey }) {
  const { t } = useSession();
  const section = t(sectionKey);

  return (
    <Screen>
      <Title title={section} />
      <Empty title={t('placeholder.title')} body={t('placeholder.body', { section })} />
    </Screen>
  );
}
