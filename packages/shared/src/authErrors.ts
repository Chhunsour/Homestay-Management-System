import type { TranslationKey } from './i18n/en.ts';

/** Structural shape of a Supabase AuthError, so this file needs no SDK import. */
export interface AuthErrorLike {
  code?: string | null;
  status?: number;
}

/** Maps Supabase auth error codes onto translation keys. Shared by both apps. */
export function authErrorKey(error: AuthErrorLike): TranslationKey {
  switch (error.code) {
    case 'invalid_credentials':
      return 'auth.error.invalidCredentials';
    case 'email_not_confirmed':
      return 'auth.error.notConfirmed';
    case 'user_already_exists':
    case 'email_exists':
    case 'phone_exists':
      return 'auth.error.emailTaken';
    case 'otp_expired':
      return 'auth.error.otpExpired';
    case 'weak_password':
      return 'auth.error.weakPassword';
    case 'email_provider_disabled':
    case 'phone_provider_disabled':
    case 'provider_disabled':
    case 'signup_disabled':
      return 'auth.error.providerDisabled';
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
    case 'over_sms_send_rate_limit':
      return 'auth.error.rateLimit';
    default:
      break;
  }

  if (error.status === 429) return 'auth.error.rateLimit';
  if (error.status === 400) return 'auth.error.otpInvalid';
  return 'error.generic';
}
