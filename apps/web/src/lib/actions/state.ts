import type { TranslationKey } from '@homestay/shared';

/**
 * Shape returned by every Server Action. `messageKey` is always an i18n key so
 * the client renders it in the user's language.
 */
export interface ActionState {
  status: 'idle' | 'error' | 'success';
  messageKey?: TranslationKey;
  /** field name -> i18n key */
  fieldErrors?: Record<string, string>;
}

export const IDLE: ActionState = { status: 'idle' };

export function failure(
  messageKey: TranslationKey,
  fieldErrors?: Record<string, string>,
): ActionState {
  return { status: 'error', messageKey, fieldErrors };
}

export function success(messageKey?: TranslationKey): ActionState {
  return { status: 'success', messageKey };
}

/** Supabase auth error -> translation key. The table itself lives in shared. */
export { authErrorKey as mapAuthError } from '@homestay/shared';
