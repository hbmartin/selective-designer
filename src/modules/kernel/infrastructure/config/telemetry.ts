import { z } from 'zod';

import {
  baseEnvSchema,
  isProdRuntimeEnvironment,
  parseEnv,
  zOptionalServiceString,
} from './env-schema';
import { assertSecureUrlInProduction } from './url-security';
import { ConfigurationError } from '../../domain/errors/configuration-error';

const telemetryEnvSchema = baseEnvSchema.extend({
  SENTRY_DSN: zOptionalServiceString(z.url()),
  VITE_SENTRY_DSN: zOptionalServiceString(z.url()),
  SENTRY_ENVIRONMENT: zOptionalServiceString(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
  SENTRY_ORG: zOptionalServiceString(),
  SENTRY_PROJECT: zOptionalServiceString(),
  SENTRY_AUTH_TOKEN: zOptionalServiceString(),
  OTEL_COLLECTOR_URL: zOptionalServiceString(z.url()),
  OTEL_COLLECTOR_BEARER_TOKEN: zOptionalServiceString(),
  OTEL_SERVICE_NAME: zOptionalServiceString(),
  OTEL_SERVICE_VERSION: zOptionalServiceString(),
  OTEL_ENVIRONMENT: zOptionalServiceString(),
  OTEL_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
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

export type TelemetryConfig = {
  dsn?: string;
  browserDsn?: string;
  environment?: string;
  tracesSampleRate: number;
  org?: string;
  project?: string;
  authToken?: string;
  collectorUrl?: string;
  collectorBearerToken?: string;
  serviceName: string;
  serviceVersion?: string;
  otelEnvironment?: string;
  otelTracesSampleRate: number;
  localSqliteEnabled: boolean;
  localSqlitePath: string;
  proxyMaxBytes: number;
  logMaxEvents: number;
  rateLimitPerMinute: number;
  requireAuth: boolean;
};

let cachedTelemetryConfig: TelemetryConfig | undefined;

export function getTelemetryConfig(): TelemetryConfig {
  if (cachedTelemetryConfig) return cachedTelemetryConfig;

  const env = parseEnv(telemetryEnvSchema);
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

  cachedTelemetryConfig = {
    dsn: env.SENTRY_DSN,
    browserDsn: env.VITE_SENTRY_DSN ?? env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE ?? (isProduction ? 0.1 : 1),
    org: env.SENTRY_ORG,
    project: env.SENTRY_PROJECT,
    authToken: env.SENTRY_AUTH_TOKEN,
    collectorUrl: env.OTEL_COLLECTOR_URL,
    collectorBearerToken: env.OTEL_COLLECTOR_BEARER_TOKEN,
    serviceName: env.OTEL_SERVICE_NAME ?? 'selective-designer',
    serviceVersion: env.OTEL_SERVICE_VERSION,
    otelEnvironment:
      env.OTEL_ENVIRONMENT ??
      env.SENTRY_ENVIRONMENT ??
      (isProduction ? 'production' : 'local'),
    otelTracesSampleRate: env.OTEL_TRACES_SAMPLE_RATE ?? 1,
    localSqliteEnabled: env.OTEL_LOCAL_SQLITE_ENABLED ?? !isProduction,
    localSqlitePath:
      env.OTEL_LOCAL_SQLITE_PATH ?? '.telemetry/telemetry.sqlite',
    proxyMaxBytes: env.TELEMETRY_PROXY_MAX_BYTES ?? 1_000_000,
    logMaxEvents: env.TELEMETRY_LOG_MAX_EVENTS ?? 50,
    rateLimitPerMinute: env.TELEMETRY_RATE_LIMIT_PER_MINUTE ?? 600,
    requireAuth: env.TELEMETRY_REQUIRE_AUTH,
  };
  return cachedTelemetryConfig;
}
