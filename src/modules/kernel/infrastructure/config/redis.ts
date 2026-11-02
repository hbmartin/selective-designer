import { z } from 'zod';

import { baseEnvSchema, parseEnv, zNonEmptyEnvString } from './env-schema';
import { assertSecureUrlInProduction } from './url-security';
import { ConfigurationError } from '../../domain/errors/configuration-error';

const redisEnvSchema = baseEnvSchema.extend({
  UPSTASH_REDIS_REST_URL: z.url().optional(),
  UPSTASH_REDIS_REST_TOKEN: zNonEmptyEnvString().optional(),
});

export type RedisConfig = {
  restUrl: string;
  restToken: string;
};

let cachedRedisConfig: RedisConfig | null | undefined;

const redisConfigMissingFieldsError = (fields: string[]) =>
  new ConfigurationError(
    `Invalid environment configuration: ${fields.join(', ')}`,
    {
      details: {
        issues: fields.map((field) => ({
          field,
          message:
            'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be configured together.',
        })),
      },
    }
  );

export function getRedisConfig(): RedisConfig | null {
  if (cachedRedisConfig !== undefined) return cachedRedisConfig;

  const env = parseEnv(redisEnvSchema);
  const restUrl = env.UPSTASH_REDIS_REST_URL;
  const restToken = env.UPSTASH_REDIS_REST_TOKEN;
  assertSecureUrlInProduction({
    name: 'UPSTASH_REDIS_REST_URL',
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
        !restUrl ? 'UPSTASH_REDIS_REST_URL' : undefined,
        !restToken ? 'UPSTASH_REDIS_REST_TOKEN' : undefined,
      ].filter((field): field is string => Boolean(field))
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
 * True only when both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
 * are present (and the URL passes the existing HTTPS/format guards).
 * Used to decide between the durable Upstash store and the in-memory default.
 */
export function isRedisConfigured(): boolean {
  return getRedisConfig() !== null;
}
