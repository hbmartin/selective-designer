/**
 * Tagged signal shared by transport and client to mark a destructive action
 * rejected because the caller's session is no longer fresh. The manager UI
 * recognizes this to prompt a step-up re-authentication instead of surfacing a
 * generic error.
 */
export const AUTH_REAUTH_REQUIRED = 'reauth_required';

/**
 * Pure freshness policy for step-up re-authentication.
 *
 * A session is fresh when its original sign-in time (`createdAtMs`) is within
 * the configured window, i.e. `now - createdAtMs <= freshAgeSeconds * 1000`.
 *
 * Fails closed: a missing or invalid timestamp is treated as NOT fresh so a
 * destructive action is challenged rather than silently allowed. Boundary code
 * parses provider timestamps before calling this domain policy.
 */
export const isSessionFresh = (input: {
  createdAtMs: number | null | undefined;
  freshAgeSeconds: number;
  now: number;
}): boolean => {
  const { createdAtMs, freshAgeSeconds, now } = input;
  if (createdAtMs === null || createdAtMs === undefined) return false;
  if (!Number.isFinite(createdAtMs)) return false;
  return now - createdAtMs <= freshAgeSeconds * 1000;
};
