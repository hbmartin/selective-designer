import { z } from 'zod';

import { baseEnvSchema, parseEnv, zNonEmptyEnvString } from './env-schema';
import { assertSecureUrlInProduction } from './url-security';
import { ConfigurationError } from '../../domain/errors/configuration-error';

const redisEnvSchema = baseEnvSchema.extend({
  UPSTASH_REDIS_REST_URL: z.url().optional(),
  UPSTASH_REDIS_REST_TOKEN: zNonEmptyEnvString().optional(),
  KV_REST_API_URL: z.url().optional(),
  KV_REST_API_TOKEN: zNonEmptyEnvString().optional(),
});

export type RedisConfig = {
  restUrl: string;
  restToken: string;
};

let cachedRedisConfig: RedisConfig | null | undefined;

const redisConfigMissingFieldsError = (
  fields: string[],
  urlField: string,
  tokenField: string
) =>
  new ConfigurationError(
    `Invalid environment configuration: ${fields.join(', ')}`,
    {
      details: {
        issues: fields.map((field) => ({
          field,
          message: `${urlField} and ${tokenField} must be configured together.`,
        })),
      },
    }
  );

export function getRedisConfig(): RedisConfig | null {
  if (cachedRedisConfig !== undefined) return cachedRedisConfig;

  const env = parseEnv(redisEnvSchema);
  // Treat each naming convention as a pair so an explicit override cannot
  // accidentally combine one database's URL with another database's token.
  const useUpstashNames =
    env.UPSTASH_REDIS_REST_URL !== undefined ||
    env.UPSTASH_REDIS_REST_TOKEN !== undefined;
  const urlField = useUpstashNames
    ? 'UPSTASH_REDIS_REST_URL'
    : 'KV_REST_API_URL';
  const tokenField = useUpstashNames
    ? 'UPSTASH_REDIS_REST_TOKEN'
    : 'KV_REST_API_TOKEN';
  const restUrl = env[urlField];
  const restToken = env[tokenField];
  assertSecureUrlInProduction({
    name: urlField,
    value: restUrl,
    env,
  });
  if (!restUrl && !restToken) {
    cachedRedisConfig = null;
    return cachedRedisConfig;
  }
  if (!restUrl || !restToken) {
    throw redisConfigMissingFieldsError(
      [
        !restUrl ? urlField : undefined,
        !restToken ? tokenField : undefined,
      ].filter((field): field is string => Boolean(field)),
      urlField,
      tokenField
    );
  }

  const config: RedisConfig = {
    restUrl,
    restToken,
  };
  cachedRedisConfig = config;
  return config;
}

/**
 * True when a complete UPSTASH_REDIS_REST_* or Vercel KV_REST_API_* pair
 * is present (and the URL passes the existing HTTPS/format guards).
 * Used to decide between the durable Upstash store and the in-memory default.
 */
export function isRedisConfigured(): boolean {
  return getRedisConfig() !== null;
}
