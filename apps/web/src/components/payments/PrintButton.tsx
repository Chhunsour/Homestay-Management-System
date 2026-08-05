'use client';

import { useT } from '@/components/LocaleProvider';
import { Button } from '@/components/ui';

/**
 * ponytail: window.print() is the share button. The browser's print dialog
 * already saves as PDF on every platform staff use, so there is no PDF library
 * here — on a phone, "Share" in that dialog sends the file straight to Messenger.
 */
export function PrintButton() {
  const { t } = useT();
  return (
    <Button variant="secondary" onClick={() => window.print()}>
      {t('receipt.print')}
    </Button>
  );
}
