import { z } from 'zod';

import { baseEnvSchema, parseEnv } from './env-schema';
import { ConfigurationError } from '../../domain/errors/configuration-error';

const schema = baseEnvSchema.extend({
  CRON_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,}$/u)
    .optional(),
});
export const getAccountingConfig = () => {
  const env = parseEnv(schema);
  if (
    env.VERCEL_ENV === 'production' &&
    (!env.CRON_SECRET ||
      env.CRON_SECRET === 'local-accounting-cron-secret-for-development')
  )
    throw new ConfigurationError(
      'CRON_SECRET is required for production accounting reconciliation.'
    );
  return { cronSecret: env.CRON_SECRET };
};
