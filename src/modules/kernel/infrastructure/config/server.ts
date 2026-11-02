import { getAuthConfig } from './auth';
import { getDatabaseConfig } from './database';
import { getEmailConfig } from './email';
import { shouldSkipEnvValidation } from './env-schema';
import { getHttpConfig } from './http';
import { getLoggerConfig } from './logger';
import { getRedisConfig } from './redis';
import { getStorageConfig } from './storage';
import { getTelemetryConfig } from './telemetry';

export function validateServerConfig() {
  if (shouldSkipEnvValidation()) return;

  getAuthConfig();
  getDatabaseConfig();
  getEmailConfig();
  getHttpConfig();
  getLoggerConfig();
  getRedisConfig();
  getStorageConfig();
  getTelemetryConfig();
}
