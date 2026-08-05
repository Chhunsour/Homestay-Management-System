'use client';

import { useT } from '@/components/LocaleProvider';
import { setCustomerArchivedAction } from '@/lib/actions/customers';
import { Button } from '@/components/ui';

/** Client-side only so archiving and restoring can ask first. */
export function CustomerStatusActions({
  customerId,
  archived,
}: {
  customerId: string;
  archived: boolean;
}) {
  const { t } = useT();
  const confirmTitle = archived ? 'customer.restore.title' : 'customer.archive.title';
  const confirmBody = archived ? 'customer.restore.body' : 'customer.archive.body';

  return (
    <form action={setCustomerArchivedAction}>
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
      <Button
        type="submit"
        variant="ghost"
        className={archived ? undefined : 'text-red-700 hover:bg-red-50'}
        onClick={(event) => {
          if (!window.confirm(`${t(confirmTitle)}\n\n${t(confirmBody)}`)) event.preventDefault();
        }}
      >
        {t(archived ? 'customer.action.restore' : 'customer.action.archive')}
      </Button>
    </form>
  );
}
