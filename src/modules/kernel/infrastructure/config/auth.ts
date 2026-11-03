import { filter, isTruthy, map, pipe } from 'remeda';
import { z } from 'zod';

import { baseEnvSchema, parseEnv, shouldSkipEnvValidation } from './env-schema';
import { ConfigurationError } from '../../domain/errors/configuration-error';

const AUTH_SECRET_MIN_LENGTH = 32;
const AUTH_SECRET_PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'change_me',
  'password',
  'replace me',
  'secret',
  'test-auth-key',
]);

const splitCsv = (value?: string) =>
  value === undefined
    ? undefined
    : pipe(
        value.split(','),
        map((item) => item.trim()),
        filter(isTruthy)
      );

const isPlaceholderAuthSecret = (value: string) =>
  AUTH_SECRET_PLACEHOLDERS.has(value.trim().toLowerCase());

const authProviderEnvSchema = baseEnvSchema.extend({
  AUTH_PROVIDER: z.enum(['better-auth', 'workos']).prefault('better-auth'),
});

const betterAuthEnvSchema = baseEnvSchema
  .extend({
    AUTH_SECRET: z.string().trim(),
    AUTH_SESSION_EXPIRATION_IN_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .prefault(604_800),
    AUTH_SESSION_UPDATE_AGE_IN_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .prefault(86_400),
    AUTH_SESSION_FRESH_AGE_IN_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .prefault(900),
    AUTH_SESSION_ABSOLUTE_MAX_IN_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .prefault(2_592_000),
    AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).prefault(60),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).prefault(100),
    AUTH_ALLOWED_HOSTS: z.string().optional(),
    AUTH_TRUSTED_ORIGINS: z.string().optional(),
    AUTH_ADMIN_ENDPOINTS_ENABLED: z.stringbool().default(false),
    AUTH_OPENAPI_ENABLED: z.stringbool().default(false),
  })
  .superRefine((env, ctx) => {
    if (!shouldSkipEnvValidation(env)) {
      if (env.AUTH_SECRET.length < AUTH_SECRET_MIN_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_SECRET'],
          message: `AUTH_SECRET must be at least ${AUTH_SECRET_MIN_LENGTH} characters`,
        });
      }

      if (isPlaceholderAuthSecret(env.AUTH_SECRET)) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_SECRET'],
          message: 'AUTH_SECRET must not use a placeholder value',
        });
      }
    }
  });

export type AuthProvider = 'better-auth' | 'workos';

export type AuthProviderConfig = {
  provider: AuthProvider;
};

export type BetterAuthConfig = {
  secret: string;
  sessionExpirationInSeconds: number;
  sessionUpdateAgeInSeconds: number;
  sessionFreshAgeInSeconds: number;
  sessionAbsoluteMaxInSeconds: number;
  rateLimitWindowSeconds: number;
  rateLimitMax: number;
  allowedHosts?: string[];
  trustedOrigins?: string[];
  adminEndpointsEnabled: boolean;
  openApiEnabled: boolean;
};

export type AuthConfig = BetterAuthConfig;

let cachedAuthProviderConfig: AuthProviderConfig | undefined;
let cachedBetterAuthConfig: BetterAuthConfig | undefined;

export function getAuthProviderConfig(): AuthProviderConfig {
  if (cachedAuthProviderConfig) return cachedAuthProviderConfig;

  const env = parseEnv(authProviderEnvSchema);
  cachedAuthProviderConfig = {
    provider: env.AUTH_PROVIDER,
  };
  return cachedAuthProviderConfig;
}

export function getBetterAuthConfig(): BetterAuthConfig {
  if (cachedBetterAuthConfig) return cachedBetterAuthConfig;

  const env = parseEnv(betterAuthEnvSchema);
  cachedBetterAuthConfig = {
    secret: env.AUTH_SECRET,
    sessionExpirationInSeconds: env.AUTH_SESSION_EXPIRATION_IN_SECONDS,
    sessionUpdateAgeInSeconds: env.AUTH_SESSION_UPDATE_AGE_IN_SECONDS,
    sessionFreshAgeInSeconds: env.AUTH_SESSION_FRESH_AGE_IN_SECONDS,
    sessionAbsoluteMaxInSeconds: env.AUTH_SESSION_ABSOLUTE_MAX_IN_SECONDS,
    rateLimitWindowSeconds: env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    rateLimitMax: env.AUTH_RATE_LIMIT_MAX,
    allowedHosts: splitCsv(env.AUTH_ALLOWED_HOSTS),
    trustedOrigins: splitCsv(env.AUTH_TRUSTED_ORIGINS),
    adminEndpointsEnabled: env.AUTH_ADMIN_ENDPOINTS_ENABLED,
    openApiEnabled: env.AUTH_OPENAPI_ENABLED,
  };
  return cachedBetterAuthConfig;
}

export function getAuthConfig(): AuthConfig {
  const { provider } = getAuthProviderConfig();
  if (provider !== 'better-auth') {
    throw new ConfigurationError(
      `AUTH_PROVIDER=${provider} is not implemented in this build.`
    );
  }
  return getBetterAuthConfig();
}
