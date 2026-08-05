'use client';

import { useT } from '@/components/LocaleProvider';
import { archivePropertyAction, setPropertyActiveAction } from '@/lib/actions/properties';
import { SubmitButton } from '@/components/SubmitButton';
import { Button } from '@/components/ui';

/** Client-side only so archiving can ask first. Both actions re-check the role. */
export function PropertyStatusActions({
  propertyId,
  isActive,
  canManage,
  canArchive,
}: {
  propertyId: string;
  isActive: boolean;
  canManage: boolean;
  canArchive: boolean;
}) {
  const { t } = useT();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canManage ? (
        <form action={setPropertyActiveAction}>
          <input type="hidden" name="propertyId" value={propertyId} />
          <input type="hidden" name="isActive" value={isActive ? 'false' : 'true'} />
          <SubmitButton
            labelKey={isActive ? 'property.action.deactivate' : 'property.action.activate'}
            variant="secondary"
          />
        </form>
      ) : null}

      {canArchive ? (
        <form action={archivePropertyAction}>
          <input type="hidden" name="propertyId" value={propertyId} />
          <Button
            type="submit"
            variant="ghost"
            className="text-red-700 hover:bg-red-50"
            onClick={(event) => {
              if (
                !window.confirm(`${t('property.archive.title')}\n\n${t('property.archive.body')}`)
              ) {
                event.preventDefault();
              }
            }}
          >
            {t('property.action.archive')}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
