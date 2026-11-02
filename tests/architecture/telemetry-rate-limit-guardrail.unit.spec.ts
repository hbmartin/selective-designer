import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guardrail for the anonymous telemetry proxies.
 *
 * The OTLP and Sentry-tunnel handlers accept forgeable non-browser traffic, so
 * they must stay behind the per-IP `enforceTelemetryRateLimit` throttle, and the
 * client IP must be derived only through the depth-aware `getClientIp` resolver
 * (never a raw, spoofable `X-Forwarded-For` read). This source-level check fails
 * loudly if a future edit drops the throttle or the sanctioned IP resolver from
 * any handler. The runtime 429 behaviour itself is covered by
 * tests/unit/composition/telemetry/transport.unit.spec.ts.
 */
const TRANSPORT_PATH = path.resolve(
  process.cwd(),
  'src/composition/telemetry/transport.ts'
);
const source = readFileSync(TRANSPORT_PATH, 'utf8');

const TELEMETRY_HANDLER_EXPORT_PATTERN =
  /^export const (handle[A-Za-z0-9]+Request)\b/gm;

const rateLimitedHandlers = [
  ...source.matchAll(TELEMETRY_HANDLER_EXPORT_PATTERN),
]
  .map((match) => match[1])
  .filter((name): name is string => name !== undefined)
  .sort();

const handlerBody = (name: string) => {
  const marker = `export const ${name}`;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const rest = source.slice(start + marker.length);
  const nextExport = rest.indexOf('\nexport const ');
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
};

const handlersMissingThrottle = rateLimitedHandlers.filter(
  (name) => !handlerBody(name).includes('enforceTelemetryRateLimit')
);

describe('telemetry transport rate limiting (regression guardrail)', () => {
  it('derives the client IP only through the sanctioned getClientIp resolver', () => {
    expect(source).toContain("from '@/platform/http/get-client-ip'");
    expect(source).toContain('getClientIp(');
  });

  it('keeps the per-IP rate-limit enforcement wiring', () => {
    expect(source).toContain('enforceTelemetryRateLimit');
    expect(source).toContain('defaultRateLimiter');
  });

  it('discovers every exported telemetry ingest handler', () => {
    expect(rateLimitedHandlers).toEqual([
      'handleFrontendLogsRequest',
      'handleOtlpProxyRequest',
      'handleSentryTunnelRequest',
    ]);
  });

  it('enforces the telemetry rate limit in every ingest handler', () => {
    expect(handlersMissingThrottle).toEqual([]);
  });
});
