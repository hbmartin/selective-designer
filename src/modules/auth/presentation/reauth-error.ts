import { isServerFnError } from '@/modules/kernel/client';

import { AUTH_REAUTH_REQUIRED } from '../domain/session-policy';

/**
 * Client predicate for the step-up re-authentication signal raised by
 * `withFreshProtectedMutation`. True when a destructive action was rejected
 * because the caller's session is no longer fresh, so the UI can prompt a
 * re-login and retry instead of showing a generic error.
 */
export const isReauthRequiredError = (error: unknown): boolean =>
  isServerFnError(error) &&
  (error.data as { reason?: unknown } | undefined)?.reason ===
    AUTH_REAUTH_REQUIRED;
