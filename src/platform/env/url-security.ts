const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

const stripIpv6Brackets = (value: string) =>
  value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;

/**
 * True when the URL points at the loopback host, allowing plain `http://`
 * during local development and CI. Mirrors the kernel-side helper; the two are
 * kept separate because `src/platform` must not import from `modules`.
 */
export const isLocalhostUrl = (value: string): boolean => {
  try {
    return LOCALHOST_HOSTNAMES.has(stripIpv6Brackets(new URL(value).hostname));
  } catch {
    return false;
  }
};

/**
 * Predicate for a zod `.refine` on URL env vars: passes when the runtime is not
 * production, the host is localhost, or the URL is HTTPS. Cleartext production
 * URLs to non-localhost hosts fail.
 */
export const isSecureUrlForProduction = (
  value: string,
  isProduction: boolean
): boolean => {
  if (!isProduction) return true;
  if (isLocalhostUrl(value)) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

export const httpsInProductionMessage = (name: string) =>
  `${name} must use HTTPS in production unless it targets localhost.`;
