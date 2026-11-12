import { z } from 'zod';

import {
  baseEnvSchema,
  isProdRuntimeEnvironment,
  parseEnv,
  unsetBlankServiceValue,
  zOptionalServiceString,
} from './env-schema';
import { assertSecureUrlInProduction } from './url-security';
import { ConfigurationError } from '../../domain/errors/configuration-error';

const sampleRate = z.preprocess(
  unsetBlankServiceValue,
  z.coerce.number().min(0).max(1).optional()
);

const sentryEnvSchema = baseEnvSchema.extend({
  SENTRY_DSN: zOptionalServiceString(z.url()),
  VITE_SENTRY_DSN: zOptionalServiceString(z.url()),
  SENTRY_ENVIRONMENT: zOptionalServiceString(),
  SENTRY_TRACES_SAMPLE_RATE: sampleRate,
  SENTRY_ORG: zOptionalServiceString(),
  SENTRY_PROJECT: zOptionalServiceString(),
  SENTRY_AUTH_TOKEN: zOptionalServiceString(),
});

const otelEnvSchema = baseEnvSchema.extend({
  OTEL_COLLECTOR_URL: zOptionalServiceString(z.url()),
  OTEL_COLLECTOR_BEARER_TOKEN: zOptionalServiceString(),
  OTEL_SERVICE_NAME: zOptionalServiceString(),
  OTEL_SERVICE_VERSION: zOptionalServiceString(),
  OTEL_ENVIRONMENT: zOptionalServiceString(),
  OTEL_TRACES_SAMPLE_RATE: sampleRate,
  SENTRY_ENVIRONMENT: zOptionalServiceString(),
});

const proxyEnvSchema = baseEnvSchema.extend({
  OTEL_LOCAL_SQLITE_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  OTEL_LOCAL_SQLITE_PATH: zOptionalServiceString(),
  TELEMETRY_PROXY_MAX_BYTES: z.coerce.number().int().positive().optional(),
  TELEMETRY_LOG_MAX_EVENTS: z.coerce.number().int().positive().optional(),
  TELEMETRY_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  TELEMETRY_REQUIRE_AUTH: z.stringbool().default(false),
});

function readOtelConfig() {
  const env = parseEnv(otelEnvSchema);
  const isProduction = isProdRuntimeEnvironment(env);
  if (env.OTEL_COLLECTOR_BEARER_TOKEN && !env.OTEL_COLLECTOR_URL) {
    throw new ConfigurationError(
      'OTEL_COLLECTOR_URL is required when OTEL_COLLECTOR_BEARER_TOKEN is configured.'
    );
  }
  assertSecureUrlInProduction({
    name: 'OTEL_COLLECTOR_URL',
    value: env.OTEL_COLLECTOR_URL,
    env,
  });
  return {
    collectorUrl: env.OTEL_COLLECTOR_URL,
    collectorBearerToken: env.OTEL_COLLECTOR_BEARER_TOKEN,
    serviceName: env.OTEL_SERVICE_NAME ?? 'selective-designer',
    serviceVersion: env.OTEL_SERVICE_VERSION,
    otelEnvironment:
      env.OTEL_ENVIRONMENT ??
      env.SENTRY_ENVIRONMENT ??
      (isProduction ? 'production' : 'local'),
    otelTracesSampleRate: env.OTEL_TRACES_SAMPLE_RATE ?? 1,
  };
}

let cachedOtelConfig: ReturnType<typeof readOtelConfig> | undefined;
export const getOtelTelemetryConfig = () =>
  (cachedOtelConfig ??= readOtelConfig());

function readSentryConfig() {
  const env = parseEnv(sentryEnvSchema);
  assertSecureUrlInProduction({
    name: 'SENTRY_DSN',
    value: env.SENTRY_DSN,
    env,
  });
  assertSecureUrlInProduction({
    name: 'VITE_SENTRY_DSN',
    value: env.VITE_SENTRY_DSN,
    env,
  });

  return {
    dsn: env.SENTRY_DSN ?? env.VITE_SENTRY_DSN,
    browserDsn: env.VITE_SENTRY_DSN ?? env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    tracesSampleRate:
      env.SENTRY_TRACES_SAMPLE_RATE ??
      (isProdRuntimeEnvironment(env) ? 0.1 : 1),
    org: env.SENTRY_ORG,
    project: env.SENTRY_PROJECT,
    authToken: env.SENTRY_AUTH_TOKEN,
  };
}

let cachedSentryConfig: ReturnType<typeof readSentryConfig> | undefined;
export const getSentryTelemetryConfig = () =>
  (cachedSentryConfig ??= readSentryConfig());

function readTelemetryConfig() {
  const otel = getOtelTelemetryConfig();
  const sentry = getSentryTelemetryConfig();
  const env = parseEnv(proxyEnvSchema);
  return {
    ...otel,
    ...sentry,
    localSqliteEnabled:
      env.OTEL_LOCAL_SQLITE_ENABLED ?? !isProdRuntimeEnvironment(env),
    localSqlitePath:
      env.OTEL_LOCAL_SQLITE_PATH ?? '.telemetry/telemetry.sqlite',
    proxyMaxBytes: env.TELEMETRY_PROXY_MAX_BYTES ?? 1_000_000,
    logMaxEvents: env.TELEMETRY_LOG_MAX_EVENTS ?? 50,
    rateLimitPerMinute: env.TELEMETRY_RATE_LIMIT_PER_MINUTE ?? 600,
    requireAuth: env.TELEMETRY_REQUIRE_AUTH,
  };
}

export type TelemetryConfig = ReturnType<typeof readTelemetryConfig>;
let cachedTelemetryConfig: TelemetryConfig | undefined;
export const getTelemetryConfig = () =>
  (cachedTelemetryConfig ??= readTelemetryConfig());
