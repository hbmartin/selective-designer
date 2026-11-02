/**
 * Best-effort client IP extraction from common proxy headers.
 *
 * `X-Forwarded-For` is a comma-separated trail where each proxy appends the
 * address it saw. Only the entries appended by *trusted* proxies are
 * meaningful; everything to the left can be forged by the original caller.
 * Callers pass `trustedProxyDepth` (the number of trusted proxy hops in front
 * of the app, configured via `TRUSTED_PROXY_DEPTH`) so the genuine client IP is
 * read `depth` hops from the end rather than the attacker-controllable
 * leftmost entry.
 *
 * This function is intentionally pure and free of module/config imports so it
 * can live in `src/platform`: the configured depth is injected by callers.
 *
 * IMPORTANT: the result is best-effort defense-in-depth (rate limiting,
 * abuse logging) only. It MUST NOT be used for authorization decisions, and it
 * is only trustworthy when a known edge/proxy sets these headers and
 * `trustedProxyDepth` matches that topology. Returns `undefined` when no
 * candidate header is present or the configured trusted hop cannot be verified.
 */
export function getClientIp(
  request: Request,
  options: { trustedProxyDepth?: number } = {}
): string | undefined {
  const depth = options.trustedProxyDepth ?? 1;
  if (!Number.isSafeInteger(depth) || depth < 1) return undefined;

  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor) {
    const parts = forwardedFor
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length > 0) {
      // Walk `depth` hops back from the end. With one trusted proxy (depth=1)
      // that is the rightmost entry, which only the immediate trusted proxy can
      // append; entries to its left are attacker-supplied and ignored. If the
      // configured hop is missing, fail closed instead of trusting the leftmost
      // value.
      if (parts.length < depth) return undefined;
      return parts[parts.length - depth];
    }
  }

  // Fallbacks for edge topologies that don't populate X-Forwarded-For. These
  // are single-value headers set by the immediate edge (no hop trail to walk),
  // so they are only meaningful when the app actually sits behind that edge:
  //   - X-Real-IP: set by nginx and many reverse proxies. Vercel also sets it,
  //     but Vercel additionally sets X-Forwarded-For, so the depth-checked XFF
  //     path above wins on Vercel and this fallback is not reached there.
  //   - CF-Connecting-IP: Cloudflare sets this to the original client IP on
  //     every proxied request; behind Cloudflare it is the reliable source.
  // If the origin is reachable directly (the edge can be bypassed by hitting the
  // app's IP/host), a caller can forge either header, exactly like XFF. The
  // result therefore stays best-effort defense-in-depth (rate limiting, abuse
  // logging) and MUST NOT drive authorization. A deployment that does not
  // terminate behind nginx/Vercel/Cloudflare should not rely on these values.
  const realIp = request.headers.get('X-Real-IP')?.trim();
  if (realIp) return realIp;

  const cfConnectingIp = request.headers.get('CF-Connecting-IP')?.trim();
  if (cfConnectingIp) return cfConnectingIp;

  return undefined;
}
