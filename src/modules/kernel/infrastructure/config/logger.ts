import { z } from 'zod';

import {
  baseEnvSchema,
  isProdRuntimeEnvironment,
  parseEnv,
} from './env-schema';
import { ConfigurationError } from '../../domain/errors/configuration-error';

const loggerEnvSchema = baseEnvSchema.extend({
  LOGGER_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .optional(),
  LOGGER_CONSOLE_MIRROR: z.stringbool().optional(),
  LOGGER_PRETTY: z.stringbool().optional(),
});

export type LoggerConfig = {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  consoleMirror: boolean;
};

type LoggerConfigResult =
  | { config: LoggerConfig; error?: never }
  | { config?: never; error: ConfigurationError };

let cachedLoggerConfig: LoggerConfigResult | undefined;

export function getLoggerConfigResult(): LoggerConfigResult {
  if (cachedLoggerConfig) return cachedLoggerConfig;

  try {
    const env = parseEnv(loggerEnvSchema);
    const isProd = isProdRuntimeEnvironment(env);
    return (cachedLoggerConfig = {
      config: {
        level: env.LOGGER_LEVEL ?? (isProd ? 'error' : 'info'),
        consoleMirror:
          env.LOGGER_CONSOLE_MIRROR ?? env.LOGGER_PRETTY ?? !isProd,
      },
    });
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return (cachedLoggerConfig = { error });
  }
}

export function getLoggerConfig(): LoggerConfig {
  const { config, error } = getLoggerConfigResult();
  if (error) throw error;
  return config;
}
