'use client';

import { useActionState, useRef } from 'react';
import { PROOF_MIME_TYPES, type PaymentProof } from '@homestay/shared';
import { uploadProofAction } from '@/lib/actions/payments';
import { IDLE } from '@/lib/actions/state';
import { useT } from '@/components/LocaleProvider';
import { SubmitButton } from '@/components/SubmitButton';
import { Alert } from '@/components/ui';

export interface ProofView extends PaymentProof {
  /** Short-lived signed URL; the bucket is private and has no public path. */
  url: string | null;
}

/**
 * The Messenger screenshot. Uploading is all any role can do — a proof is
 * evidence, so there is no replace and no delete, in the policies or here.
 */
export function ProofManager({
  paymentId,
  bookingId,
  proofs,
  canUpload,
}: {
  paymentId: string;
  bookingId: string;
  proofs: ProofView[];
  canUpload: boolean;
}) {
  const { t } = useT();
  const [state, action] = useActionState(uploadProofAction, IDLE);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-4 border-t border-slate-100 p-5">
      {state.status !== 'idle' && state.messageKey ? (
        <Alert tone={state.status === 'error' ? 'error' : 'success'}>{t(state.messageKey)}</Alert>
      ) : null}

      {canUpload ? (
        <form
          action={action}
          className="flex flex-wrap items-end gap-3"
          // Otherwise the file stays selected and a second submit uploads it twice.
          onSubmit={() => setTimeout(() => fileInput.current?.form?.reset(), 0)}
        >
          <input type="hidden" name="paymentId" value={paymentId} />
          <input type="hidden" name="bookingId" value={bookingId} />
          <div className="space-y-1.5">
            <label htmlFor="proof" className="block text-sm font-medium text-slate-800">
              {t('payment.proof.add')}
            </label>
            <input
              ref={fileInput}
              id="proof"
              name="file"
              type="file"
              required
              accept={PROOF_MIME_TYPES.join(',')}
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-sm file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-800 hover:file:bg-slate-50"
            />
            <p className="text-xs text-slate-500">{t('payment.proof.hint')}</p>
          </div>
          <SubmitButton labelKey="payment.proof.add" variant="secondary" />
        </form>
      ) : null}

      {proofs.length === 0 ? (
        <p className="text-sm text-slate-600">{t('payment.proof.empty')}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {proofs.map((proof) => (
            <li key={proof.id} className="overflow-hidden rounded-sm border border-slate-200">
              {/* ponytail: plain <img>. The URLs are signed and expire, so
                  next/image would only add a remotePatterns entry to maintain. */}
              {proof.url && proof.mime_type !== 'application/pdf' ? (
                <a href={proof.url} target="_blank" rel="noreferrer">
                  <img
                    src={proof.url}
                    alt={proof.file_name}
                    className="aspect-3/4 w-full bg-slate-100 object-contain"
                  />
                </a>
              ) : (
                <div className="flex aspect-3/4 items-center justify-center bg-slate-50 text-sm text-slate-600">
                  {proof.url ? (
                    <a
                      href={proof.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-brand-800 hover:underline"
                    >
                      {t('payment.proof.pdf')}
                    </a>
                  ) : (
                    t('payment.proof.error.load')
                  )}
                </div>
              )}
              <p className="truncate border-t border-slate-200 px-2 py-1.5 text-xs text-slate-600">
                {proof.file_name}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
