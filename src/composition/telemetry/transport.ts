import { sanitizeLogFields } from '@/platform/lib/redaction/sanitize-log-fields';

import { getAuthUseCases } from '@/composition/auth';
import { getKernel } from '@/composition/kernel';
import { getHttpConfig } from '@/modules/kernel/backend';
import { getTelemetryConfig } from '@/modules/kernel/infrastructure/config/telemetry';
import {
  appendBrowserMutationVaryHeader,
  validateSameOriginBrowserMutationRequest,
} from '@/platform/http/browser-mutation-protection';
import { getClientIp } from '@/platform/http/get-client-ip';
import { defaultRateLimiter } from '@/platform/http/rate-limiter';
import type { TelemetryAdapter, TelemetryLogLevel } from '@/platform/telemetry';
import { getTelemetry } from '@/platform/telemetry';

import { telemetrySignalUrl } from './collector-url';
import { recordLocalTelemetrySummary } from './local-sqlite-sink';

const RATE_LIMIT_WINDOW_MS = 60_000;

type OtlpSignal = 'metrics' | 'traces';

type FrontendLogRecord = {
  level: TelemetryLogLevel;
  event: string;
  message?: string;
  details?: Record<string, unknown>;
  error?: string;
  traceId?: string;
  spanId?: string;
  timestamp?: string;
};

const OTLP_CONTENT_TYPES = new Set([
  'application/x-protobuf',
  'application/octet-stream',
]);
const SENTRY_ENVELOPE_CONTENT_TYPES = new Set([
  'application/octet-stream',
  'application/x-sentry-envelope',
  'text/plain',
]);
const JSON_CONTENT_TYPES = new Set(['application/json']);
const FRONTEND_LOG_LEVELS = new Set<TelemetryLogLevel>([
  'debug',
  'error',
  'info',
  'warn',
]);

type KernelLogger = ReturnType<typeof getKernel>['logger'];
type KernelLogFields = Parameters<KernelLogger['info']>[0];

const contentType = (request: Request) =>
  request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ??
  '';

const forbidden = (reason: string) =>
  new Response(JSON.stringify({ error: 'forbidden', reason }), {
    headers: { 'Content-Type': 'application/json' },
    status: 403,
  });

const unsupportedMediaType = () =>
  new Response(JSON.stringify({ error: 'unsupported_media_type' }), {
    headers: { 'Content-Type': 'application/json' },
    status: 415,
  });

const payloadTooLarge = () =>
  new Response(JSON.stringify({ error: 'payload_too_large' }), {
    headers: { 'Content-Type': 'application/json' },
    status: 413,
  });

const badRequest = () =>
  new Response(JSON.stringify({ error: 'invalid_request_body' }), {
    headers: { 'Content-Type': 'application/json' },
    status: 400,
  });

const tooManyEvents = () =>
  new Response(JSON.stringify({ error: 'too_many_events' }), {
    headers: { 'Content-Type': 'application/json' },
    status: 413,
  });

const tooManyRequests = (retryAfterSeconds: number) =>
  new Response(JSON.stringify({ error: 'too_many_requests' }), {
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds),
    },
    status: 429,
  });

const unauthorized = () =>
  new Response(JSON.stringify({ error: 'unauthorized' }), {
    headers: { 'Content-Type': 'application/json' },
    status: 401,
  });

const accepted = () => new Response(null, { status: 202 });
const noContent = () => new Response(null, { status: 204 });

const withTelemetryVary = (response: Response) =>
  appendBrowserMutationVaryHeader(response);

const isTelemetryLogLevel = (value: unknown): value is TelemetryLogLevel =>
  typeof value === 'string' &&
  FRONTEND_LOG_LEVELS.has(value as TelemetryLogLevel);

const validateTelemetryMutationRequest = (
  request: Request,
  allowedContentTypes: ReadonlySet<string>
) => {
  const sameOrigin = validateSameOriginBrowserMutationRequest(request);
  if (!sameOrigin.ok) {
    return withTelemetryVary(forbidden(sameOrigin.reason));
  }

  if (!allowedContentTypes.has(contentType(request))) {
    return withTelemetryVary(unsupportedMediaType());
  }

  return undefined;
};

/**
 * Best-effort per-IP rate limit. The same-origin guard is a CSRF control, not
 * authentication, so these endpoints still accept forgeable non-browser
 * traffic; this caps abuse/cost amplification per process. The client IP is
 * derived with the configured `TRUSTED_PROXY_DEPTH` so a spoofed leftmost
 * `X-Forwarded-For` entry cannot mint a fresh per-IP bucket and bypass the cap.
 *
 * IMPORTANT: this limiter is in-memory and per-process, so on serverless /
 * multi-instance deployments each instance counts independently. Durable,
 * cross-instance rate limiting must be enforced at the edge/WAF (see
 * `docs/security-rate-limiting.md`); `TELEMETRY_REQUIRE_AUTH=true` is the
 * in-app lock-down that closes the anonymous proxy entirely. `scope` keeps a
 * single page's traffic to one endpoint from starving the others.
 */
const enforceTelemetryRateLimit = (request: Request, scope: string) => {
  const { rateLimitPerMinute } = getTelemetryConfig();
  const ip =
    getClientIp(request, {
      trustedProxyDepth: getHttpConfig().trustedProxyDepth,
    }) ?? 'unknown';
  const result = defaultRateLimiter.check(
    `telemetry:${scope}:${ip}`,
    rateLimitPerMinute,
    RATE_LIMIT_WINDOW_MS
  );
  if (result.allowed) return undefined;
  return withTelemetryVary(tooManyRequests(result.retryAfterSeconds));
};

const hasAuthenticatedSession = async (request: Request) => {
  const result = await getAuthUseCases().getCurrentSession({
    headers: request.headers,
  });
  if (result.isError()) return false;
  return result.get().type === 'auth_session_found';
};

/**
 * Optional auth lock-down for the anonymous telemetry proxies. When
 * `TELEMETRY_REQUIRE_AUTH=true`, the OTLP and Sentry-tunnel proxies require an
 * authenticated session before forwarding (mirroring the always-on gate on
 * `/api/telemetry/logs`). Off by default so pre-login browser telemetry keeps
 * working.
 */
const enforceTelemetryAuth = async (request: Request) => {
  if (!getTelemetryConfig().requireAuth) return undefined;
  if (await hasAuthenticatedSession(request)) return undefined;
  return withTelemetryVary(unauthorized());
};

const readBoundedBody = async (request: Request) => {
  const config = getTelemetryConfig();
  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > config.proxyMaxBytes) {
    return { ok: false as const, response: payloadTooLarge() };
  }

  if (!request.body) {
    return { ok: true as const, body: new ArrayBuffer(0) };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    const reader = request.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > config.proxyMaxBytes) {
        await reader.cancel();
        return { ok: false as const, response: payloadTooLarge() };
      }

      chunks.push(value);
    }
  } catch {
    return { ok: false as const, response: badRequest() };
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true as const, body: body.buffer };
};

const forwardToCollector = async (
  signal: OtlpSignal,
  body: ArrayBuffer,
  requestContentType: string
) => {
  const config = getTelemetryConfig();
  if (!config.collectorUrl) {
    recordLocalTelemetrySummary({
      bytes: body.byteLength,
      kind: 'otlp_proxy',
      signal,
      statusCode: 204,
      summary: { forwarded: false, reason: 'missing_collector_env' },
    });
    return noContent();
  }

  const headers: Record<string, string> = {
    'Content-Type': requestContentType,
    ...(config.collectorBearerToken
      ? { Authorization: `Bearer ${config.collectorBearerToken}` }
      : {}),
  };
  const collectorResponse = await fetch(
    telemetrySignalUrl(config.collectorUrl, signal),
    {
      body,
      headers,
      method: 'POST',
    }
  );
  const status = collectorResponse.ok ? 202 : 502;

  recordLocalTelemetrySummary({
    bytes: body.byteLength,
    kind: 'otlp_proxy',
    signal,
    statusCode: status,
    summary: { collectorStatus: collectorResponse.status, forwarded: true },
  });

  return new Response(null, { status });
};

const sentryEnvelopeEndpoint = (dsn: string) => {
  const parsed = new URL(dsn);
  const projectId = parsed.pathname.split('/').filter(Boolean).at(-1);
  if (!projectId) return undefined;

  return `${parsed.origin}/api/${projectId}/envelope/`;
};

const forwardSentryEnvelope = async (body: ArrayBuffer) => {
  const config = getTelemetryConfig();
  const endpoint = config.browserDsn
    ? sentryEnvelopeEndpoint(config.browserDsn)
    : undefined;
  if (!endpoint) {
    recordLocalTelemetrySummary({
      bytes: body.byteLength,
      kind: 'sentry_tunnel',
      statusCode: 204,
      summary: { forwarded: false, reason: 'missing_sentry_dsn' },
    });
    return noContent();
  }

  const sentryResponse = await fetch(endpoint, {
    body,
    headers: { 'Content-Type': 'application/x-sentry-envelope' },
    method: 'POST',
  });
  const status = sentryResponse.ok ? 202 : 502;

  recordLocalTelemetrySummary({
    bytes: body.byteLength,
    kind: 'sentry_tunnel',
    statusCode: status,
    summary: { forwarded: true, sentryStatus: sentryResponse.status },
  });

  return new Response(null, { status });
};

export const handleOtlpProxyRequest = async (
  request: Request,
  signal: OtlpSignal
) => {
  const invalid = validateTelemetryMutationRequest(request, OTLP_CONTENT_TYPES);
  if (invalid) return invalid;

  const rateLimited = enforceTelemetryRateLimit(request, signal);
  if (rateLimited) return rateLimited;

  const unauthenticated = await enforceTelemetryAuth(request);
  if (unauthenticated) return unauthenticated;

  const body = await readBoundedBody(request);
  if (!body.ok) return withTelemetryVary(body.response);

  return withTelemetryVary(
    await forwardToCollector(signal, body.body, contentType(request))
  );
};

export const handleSentryTunnelRequest = async (request: Request) => {
  const invalid = validateTelemetryMutationRequest(
    request,
    SENTRY_ENVELOPE_CONTENT_TYPES
  );
  if (invalid) return invalid;

  const rateLimited = enforceTelemetryRateLimit(request, 'sentry');
  if (rateLimited) return rateLimited;

  const unauthenticated = await enforceTelemetryAuth(request);
  if (unauthenticated) return unauthenticated;

  const body = await readBoundedBody(request);
  if (!body.ok) return withTelemetryVary(body.response);

  return withTelemetryVary(await forwardSentryEnvelope(body.body));
};

const isFrontendLogRecord = (value: unknown): value is FrontendLogRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isTelemetryLogLevel(record.level) && typeof record.event === 'string';
};

const optionalString = (value: unknown) =>
  typeof value === 'string' ? value : undefined;

const recordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const frontendLogEvent = (record: Record<string, unknown>) => {
  const event = optionalString(record.event);
  return event ? `frontend.${event}` : 'frontend.log';
};

const frontendLogLevel = (record: Record<string, unknown>) =>
  isTelemetryLogLevel(record.level) ? record.level : 'info';

const frontendTraceDetails = (record: Record<string, unknown>) => {
  const spanId = optionalString(record.spanId);
  const traceId = optionalString(record.traceId);

  return {
    ...(spanId ? { spanId } : {}),
    ...(traceId ? { traceId } : {}),
  };
};

const frontendTelemetryAttributes = (record: Record<string, unknown>) => {
  const spanId = optionalString(record.spanId);
  const traceId = optionalString(record.traceId);

  return {
    'log.source': 'frontend',
    ...(traceId ? { 'trace.id': traceId } : {}),
    ...(spanId ? { 'span.id': spanId } : {}),
  };
};

const frontendTimestamp = (record: Record<string, unknown>) => {
  const timestamp = optionalString(record.timestamp);
  return timestamp ? new Date(timestamp) : undefined;
};

const writeFrontendBackendLog = (
  logger: KernelLogger,
  level: TelemetryLogLevel,
  fields: KernelLogFields
) => {
  switch (level) {
    case 'debug':
      logger.debug(fields);
      return;
    case 'error':
      logger.error(fields);
      return;
    case 'info':
      logger.info(fields);
      return;
    case 'warn':
      logger.warn(fields);
      return;
  }
};

const recordFrontendLog = ({
  logger,
  record,
  telemetry,
}: {
  logger: KernelLogger;
  record: FrontendLogRecord;
  telemetry: TelemetryAdapter;
}) => {
  const sanitized = sanitizeLogFields(record);
  const details = recordValue(sanitized.details);
  const event = frontendLogEvent(sanitized);
  const level = frontendLogLevel(sanitized);
  const error = optionalString(sanitized.error);
  const message = optionalString(sanitized.message);

  writeFrontendBackendLog(logger, level, {
    details: {
      ...details,
      ...frontendTraceDetails(sanitized),
    },
    direction: 'inbound',
    error,
    event,
    telemetryExtras: { frontendLog: sanitized },
    telemetryTags: { source: 'frontend' },
  });

  telemetry.emitLog({
    attributes: frontendTelemetryAttributes(sanitized),
    details,
    error,
    event,
    level,
    message,
    timestamp: frontendTimestamp(sanitized),
  });

  // Frontend-origin records are recorded as logs (above) but intentionally do
  // NOT call `telemetry.captureException`. This relay accepts user-supplied
  // records, so auto-promoting `level:'error'` records into Sentry exceptions
  // would let a low-privilege authenticated caller inflate the error stream and
  // exhaust Sentry quota. The `level:'error'` signal is preserved on the emitted
  // log (tagged `source:'frontend'`) for querying; genuine exceptions are
  // captured by the server's own error paths.
};

const toFrontendLogBatch = async (request: Request) => {
  const body = await readBoundedBody(request);
  if (!body.ok) return { ok: false as const, response: body.response };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body.body));
  } catch {
    return {
      ok: false as const,
      response: new Response(JSON.stringify({ error: 'invalid_json' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 400,
      }),
    };
  }

  const records =
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as { records?: unknown }).records)
      ? (parsed as { records: unknown[] }).records
      : [];
  const config = getTelemetryConfig();
  if (records.length > config.logMaxEvents) {
    return { ok: false as const, response: tooManyEvents() };
  }

  return {
    ok: true as const,
    records: records.filter(isFrontendLogRecord),
    bytes: body.body.byteLength,
  };
};

export const handleFrontendLogsRequest = async (request: Request) => {
  const invalid = validateTelemetryMutationRequest(request, JSON_CONTENT_TYPES);
  if (invalid) return invalid;

  const rateLimited = enforceTelemetryRateLimit(request, 'logs');
  if (rateLimited) return rateLimited;

  // The frontend log sink writes into the trusted server log/telemetry stream,
  // so require an authenticated session. Anonymous (pre-login) client logs are
  // intentionally dropped to keep this endpoint from being an open log relay.
  if (!(await hasAuthenticatedSession(request))) {
    return withTelemetryVary(unauthorized());
  }

  const batch = await toFrontendLogBatch(request);
  if (!batch.ok) return withTelemetryVary(batch.response);

  const logger = getKernel().logger;
  const telemetry = getTelemetry();

  for (const record of batch.records) {
    recordFrontendLog({ logger, record, telemetry });
  }

  recordLocalTelemetrySummary({
    bytes: batch.bytes,
    eventCount: batch.records.length,
    kind: 'frontend_log',
    signal: 'logs',
    statusCode: 202,
    summary: { accepted: true },
  });

  return withTelemetryVary(accepted());
};
