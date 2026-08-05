'use client';

import { useActionState, useRef } from 'react';
import { PHOTO_MIME_TYPES, type PropertyPhoto } from '@homestay/shared';
import {
  deletePhotoAction,
  setCoverPhotoAction,
  uploadPhotoAction,
} from '@/lib/actions/properties';
import { IDLE } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { SubmitButton } from '@/components/SubmitButton';
import { Alert, Badge, Button } from '@/components/ui';

export interface PhotoView extends PropertyPhoto {
  /** Short-lived signed URL; the bucket is private. */
  url: string | null;
}

export function PhotoManager({
  propertyId,
  photos,
  canManage,
  maxSizeLabel,
}: {
  propertyId: string;
  photos: PhotoView[];
  canManage: boolean;
  maxSizeLabel: string;
}) {
  const { t } = useT();
  const [state, action] = useActionState(uploadPhotoAction, IDLE);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-4 border-t border-slate-100 p-5">
      {state.status === 'error' && state.messageKey ? (
        <Alert tone="error">{t(state.messageKey)}</Alert>
      ) : null}
      {state.status === 'success' && state.messageKey ? (
        <Alert tone="success">{t(state.messageKey)}</Alert>
      ) : null}

      {canManage ? (
        <form
          action={action}
          className="flex flex-wrap items-end gap-3"
          // The action keeps the chosen file otherwise, and re-submitting would
          // upload the same image twice.
          onSubmit={() => setTimeout(() => fileInput.current?.form?.reset(), 0)}
        >
          <input type="hidden" name="propertyId" value={propertyId} />
          <div className="space-y-1.5">
            <label htmlFor="file" className="block text-sm font-medium text-slate-800">
              {t('photo.choose')}
            </label>
            <input
              ref={fileInput}
              id="file"
              name="file"
              type="file"
              required
              accept={PHOTO_MIME_TYPES.join(',')}
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-sm file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-800 hover:file:bg-slate-50"
            />
            <p className="text-xs text-slate-500">{t('photo.subtitle', { size: maxSizeLabel })}</p>
          </div>
          <SubmitButton labelKey="photo.upload" variant="secondary" />
        </form>
      ) : null}

      {photos.length === 0 ? (
        <p className="text-sm text-slate-600">{t('photo.empty')}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {photos.map((photo) => (
            <li key={photo.id} className="overflow-hidden rounded-sm border border-slate-200">
              <div className="relative aspect-4/3 bg-slate-100">
                {/* ponytail: plain <img>. The URLs are signed and short-lived, so
                    next/image would only add a remotePatterns entry to maintain. */}
                {photo.url ? (
                  <img
                    src={photo.url}
                    alt={photo.file_name ?? ''}
                    className="size-full object-cover"
                  />
                ) : null}
                {photo.is_cover ? (
                  <span className="absolute top-1.5 left-1.5">
                    <Badge>{t('photo.cover')}</Badge>
                  </span>
                ) : null}
              </div>

              {canManage ? (
                <div className="flex items-center justify-between gap-1 border-t border-slate-200 px-2 py-1.5">
                  {photo.is_cover ? (
                    <span className="text-xs text-slate-400">{t('photo.cover')}</span>
                  ) : (
                    <form action={setCoverPhotoAction}>
                      <input type="hidden" name="photoId" value={photo.id} />
                      <input type="hidden" name="propertyId" value={propertyId} />
                      <Button type="submit" variant="ghost" className="px-1.5 py-1 text-xs">
                        {t('photo.setCover')}
                      </Button>
                    </form>
                  )}
                  <form action={deletePhotoAction}>
                    <input type="hidden" name="photoId" value={photo.id} />
                    <Button
                      type="submit"
                      variant="ghost"
                      className="px-1.5 py-1 text-xs text-red-700 hover:bg-red-50"
                      onClick={(event) => {
                        if (!window.confirm(t('photo.deleteConfirm'))) event.preventDefault();
                      }}
                    >
                      {t('common.delete')}
                    </Button>
                  </form>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
