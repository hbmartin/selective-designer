import { errorCauses } from '@/modules/kernel/domain/errors/error-causes';

const PERMANENT_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_INVALID_URL',
  'UND_ERR_INVALID_ARG',
]);

export const isPermanentSourceFailure = (error: unknown) =>
  [...errorCauses(error)].some(
    (cause) =>
      (typeof cause.code === 'string' && PERMANENT_CODES.has(cause.code)) ||
      cause.message === 'redirect count exceeded' ||
      cause.message === 'invalid redirect'
  );

/** HTTP boundary mapping: support both delay-seconds and HTTP dates. */
export function sourceRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+$/u.test(value)) {
    // A valid but enormous delay is excessive, not an absent header.
    return Number(value) * 1000;
  }
  const deadline = Date.parse(value);
  return Number.isFinite(deadline)
    ? Math.max(0, deadline - Date.now())
    : undefined;
}
