import { z } from 'zod';

import {
  baseEnvSchema,
  parseEnv,
  unsetBlankServiceValue,
  zNonEmptyEnvString,
} from './env-schema';
import { assertSecureUrlInProduction } from './url-security';
import { ConfigurationError } from '../../domain/errors/configuration-error';

const upstashPair = {
  url: 'UPSTASH_REDIS_REST_URL',
  token: 'UPSTASH_REDIS_REST_TOKEN',
} as const;
const vercelPair = {
  url: 'KV_REST_API_URL',
  token: 'KV_REST_API_TOKEN',
} as const;

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

  const env = parseEnv(baseEnvSchema);
  const pair =
    unsetBlankServiceValue(env[upstashPair.url]) !== undefined ||
    unsetBlankServiceValue(env[upstashPair.token]) !== undefined
      ? upstashPair
      : vercelPair;
  const url = unsetBlankServiceValue(env[pair.url]);
  const token = unsetBlankServiceValue(env[pair.token]);
  if (url === undefined && token === undefined) {
    cachedRedisConfig = null;
    return cachedRedisConfig;
  }

  const missing = [
    ...(url === undefined ? [pair.url] : []),
    ...(token === undefined ? [pair.token] : []),
  ];
  if (missing.length > 0) {
    throw redisConfigMissingFieldsError(missing, pair.url, pair.token);
  }

  const selected = parseEnv(
    z.object({ [pair.url]: z.url(), [pair.token]: zNonEmptyEnvString() }),
    { [pair.url]: url, [pair.token]: token }
  );
  const restUrl = selected[pair.url]!;
  const restToken = selected[pair.token]!;
  assertSecureUrlInProduction({ name: pair.url, value: restUrl, env });
  const config = { restUrl, restToken };
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
