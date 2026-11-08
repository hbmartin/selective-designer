import { getAccountingConfig } from './accounting';
import {
  getAiProvidersConfig,
  validateAiProvidersBuildConfig,
} from './ai-providers';
import { getAuthConfig } from './auth';
import { getDatabaseConfig } from './database';
import { shouldSkipEnvValidation } from './env-schema';
import { getHttpConfig } from './http';
import { getLoggerConfig } from './logger';
import { getRedisConfig } from './redis';
import { getStorageConfig } from './storage';
import { getTelemetryConfig } from './telemetry';

function validateInfrastructureConfig() {
  getAccountingConfig();
  getAuthConfig();
  getDatabaseConfig();
  getHttpConfig();
  getLoggerConfig();
  getRedisConfig();
  getStorageConfig();
  getTelemetryConfig();
}

export function validateServerConfig() {
  if (shouldSkipEnvValidation()) return;
  validateInfrastructureConfig();
  getAiProvidersConfig();
}

export function validateServerBuildConfig() {
  if (shouldSkipEnvValidation()) return;
  validateInfrastructureConfig();
  validateAiProvidersBuildConfig();
}
