import { z } from 'zod';

import {
  baseEnvSchema,
  isProdRuntimeEnvironment,
  parseEnv,
} from './env-schema';
import { ConfigurationError } from '../../domain/errors/configuration-error';

const schema = baseEnvSchema.extend({
  CRON_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,}$/u)
    .optional(),
});
export const getAccountingConfig = () => {
  const env = parseEnv(schema);
  const deployed =
    isProdRuntimeEnvironment(env) ||
    env.VERCEL_ENV === 'production' ||
    env.VERCEL_ENV === 'preview';
  const production =
    env.VERCEL_ENV === 'production' ||
    (isProdRuntimeEnvironment(env) && env.VERCEL_ENV !== 'preview');
  if (
    (production && !env.CRON_SECRET) ||
    (deployed &&
      env.CRON_SECRET === 'local-accounting-cron-secret-for-development')
  )
    throw new ConfigurationError(
      'CRON_SECRET must be a private secret in deployed environments and is required in production.'
    );
  return { cronSecret: env.CRON_SECRET };
};
