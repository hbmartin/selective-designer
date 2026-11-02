import { makeTestDatabaseUrl } from '@tests/server/test-database-url';
import {
  makeShortTestSecret,
  makeStrongTestSecret,
  makeTestSecret,
} from '@tests/support/test-secrets';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('server config accessors', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('SKIP_ENV_VALIDATION', undefined);
  });

  it('caches parsed database config', async () => {
    const firstDatabaseUrl = makeTestDatabaseUrl({
      credentialLabel: 'first',
      databaseName: 'first',
    });
    const secondDatabaseUrl = makeTestDatabaseUrl({
      credentialLabel: 'second',
      databaseName: 'second',
    });

    vi.stubEnv('DATABASE_URL', firstDatabaseUrl);
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    const first = getDatabaseConfig();
    vi.stubEnv('DATABASE_URL', secondDatabaseUrl);

    expect(getDatabaseConfig()).toBe(first);
    expect(getDatabaseConfig().databaseUrl).toBe(firstDatabaseUrl);
    expect(getDatabaseConfig().driver).toBe('node-pg');
  });

  it('parses explicit database driver config', async () => {
    const databaseUrl = makeTestDatabaseUrl();

    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv('DATABASE_DRIVER', 'neon-http');
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getDatabaseConfig()).toEqual({
      databaseUrl,
      driver: 'neon-http',
    });
  });

  it('defaults migration config to node-pg for node-pg runtime drivers', async () => {
    const databaseUrl = makeTestDatabaseUrl();

    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv('DATABASE_DRIVER', 'node-pg');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getMigrationDatabaseConfig()).toEqual({
      databaseUrl,
      driver: 'node-pg',
    });
  });

  it.each(['neon-http', 'neon-websocket'] as const)(
    'defaults migration config to Neon WebSocket for %s runtime drivers',
    async (driver) => {
      const databaseUrl = makeTestDatabaseUrl();

      vi.stubEnv('DATABASE_URL', databaseUrl);
      vi.stubEnv('DATABASE_DRIVER', driver);
      const { getMigrationDatabaseConfig } =
        await import('@/modules/kernel/infrastructure/config/database');

      expect(getMigrationDatabaseConfig()).toEqual({
        databaseUrl,
        driver: 'neon-websocket',
      });
    }
  );

  it('uses explicit migration URL and driver config', async () => {
    const runtimeDatabaseUrl = makeTestDatabaseUrl({
      credentialLabel: 'runtime',
    });
    const migrationDatabaseUrl = makeTestDatabaseUrl({
      credentialLabel: 'migration',
    });

    vi.stubEnv('DATABASE_URL', runtimeDatabaseUrl);
    vi.stubEnv('DATABASE_DRIVER', 'neon-http');
    vi.stubEnv('DATABASE_MIGRATION_URL', migrationDatabaseUrl);
    vi.stubEnv('DATABASE_MIGRATION_DRIVER', 'node-pg');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getMigrationDatabaseConfig()).toEqual({
      databaseUrl: migrationDatabaseUrl,
      driver: 'node-pg',
    });
  });

  it('rejects Neon HTTP as a migration driver', async () => {
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    vi.stubEnv('DATABASE_MIGRATION_DRIVER', 'neon-http');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getMigrationDatabaseConfig()).toThrow(ConfigurationError);
  });

  it('rejects likely transaction-pooled migration URLs', async () => {
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    vi.stubEnv(
      'DATABASE_MIGRATION_URL',
      makeTestDatabaseUrl({
        host: 'ep-example-pooler.us-east-1.aws.neon.tech',
        port: null,
      })
    );
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getMigrationDatabaseConfig()).toThrow(ConfigurationError);
  });

  it('detects likely transaction-pooled database URLs', async () => {
    const { isLikelyTransactionPooledDatabaseUrl } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(
      isLikelyTransactionPooledDatabaseUrl(
        makeTestDatabaseUrl({
          databaseName: 'db',
          host: 'ep-example-pooler.us-east-1.aws.neon.tech',
          port: null,
        })
      )
    ).toBe(true);
    expect(
      isLikelyTransactionPooledDatabaseUrl(
        makeTestDatabaseUrl({
          databaseName: 'db',
          searchParams: { pool_mode: 'transaction' },
        })
      )
    ).toBe(true);
    expect(
      isLikelyTransactionPooledDatabaseUrl(
        makeTestDatabaseUrl({ databaseName: 'db' })
      )
    ).toBe(false);
  });

  it('defaults the auth provider to Better Auth', async () => {
    vi.stubEnv('AUTH_PROVIDER', undefined);
    const { getAuthProviderConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');

    expect(getAuthProviderConfig()).toEqual({ provider: 'better-auth' });
  });

  it('parses WorkOS as a reserved auth provider without Better Auth secrets', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'workos');
    vi.stubEnv('AUTH_SECRET', undefined);
    const { getAuthProviderConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');

    expect(getAuthProviderConfig()).toEqual({ provider: 'workos' });
  });

  it('rejects reserved auth providers through the Better Auth config accessor', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'workos');
    vi.stubEnv('AUTH_SECRET', undefined);
    const { getAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getAuthConfig()).toThrow(ConfigurationError);
  });

  it('rejects short AUTH_SECRET values without exposing the value', async () => {
    expect.assertions(3);
    const weakAuthValue = makeShortTestSecret('auth');
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', weakAuthValue);
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    let error: unknown;
    try {
      getBetterAuthConfig();
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain('AUTH_SECRET');
    expect((error as Error).message).not.toContain(weakAuthValue);
  });

  it('rejects placeholder AUTH_SECRET values', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', 'replace me');
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getBetterAuthConfig()).toThrow(ConfigurationError);
  });

  it('accepts strong AUTH_SECRET values', async () => {
    const authValue = makeStrongTestSecret('auth');
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', authValue);
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');

    expect(getBetterAuthConfig().secret).toBe(authValue);
  });

  it('allows weak AUTH_SECRET values only when non-production env validation is skipped', async () => {
    const weakAuthValue = makeShortTestSecret('auth');
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', weakAuthValue);
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');

    expect(getBetterAuthConfig().secret).toBe(weakAuthValue);
  });

  it('rejects weak AUTH_SECRET values in production even when env validation is skipped', async () => {
    const weakAuthValue = makeShortTestSecret('auth');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', weakAuthValue);
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getBetterAuthConfig()).toThrow(ConfigurationError);
    expect(() => getBetterAuthConfig()).toThrow('AUTH_SECRET');
  });

  it('rejects placeholder AUTH_SECRET values in production even when env validation is skipped', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', 'replace me');
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getBetterAuthConfig()).toThrow(ConfigurationError);
    expect(() => getBetterAuthConfig()).toThrow('AUTH_SECRET');
  });

  it('skips server config validation outside production when SKIP_ENV_VALIDATION is true', async () => {
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
    vi.stubEnv('AUTH_SECRET', undefined);
    vi.stubEnv('DATABASE_URL', undefined);

    const { validateServerConfig } =
      await import('@/modules/kernel/infrastructure/config/server');

    expect(() => validateServerConfig()).not.toThrow();
  });

  it('runs server config validation in production even when SKIP_ENV_VALIDATION is true', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
    vi.stubEnv('AUTH_SECRET', undefined);
    vi.stubEnv('DATABASE_URL', undefined);
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    const { validateServerConfig } =
      await import('@/modules/kernel/infrastructure/config/server');

    expect(() => validateServerConfig()).toThrow(ConfigurationError);
  });

  it('returns null for absent optional Redis config', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined);
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined);
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');

    expect(getRedisConfig()).toBeNull();
  });

  it('throws ConfigurationError for partial optional Redis config', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.com');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined);
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getRedisConfig()).toThrow(ConfigurationError);
    expect(() => getRedisConfig()).toThrow('UPSTASH_REDIS_REST_TOKEN');
  });

  it('throws ConfigurationError when Redis token is present without URL', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined);
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', makeTestSecret('redis'));
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getRedisConfig()).toThrow(ConfigurationError);
    expect(() => getRedisConfig()).toThrow('UPSTASH_REDIS_REST_URL');
  });

  it('returns Redis config when both required values are present', async () => {
    const redisToken = makeTestSecret('redis');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.com');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', redisToken);
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');

    expect(getRedisConfig()).toEqual({
      restUrl: 'https://redis.example.com',
      restToken: redisToken,
    });
  });

  it('throws ConfigurationError for malformed Redis config', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'not-a-url');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', makeTestSecret('redis'));
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getRedisConfig()).toThrow(ConfigurationError);
  });

  it('reports Redis as configured only when both values are present', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.com');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', makeTestSecret('redis'));
    const { isRedisConfigured } =
      await import('@/modules/kernel/infrastructure/config/redis');

    expect(isRedisConfigured()).toBe(true);
  });

  it('throws ConfigurationError when checking partial Redis config', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.com');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined);
    const { isRedisConfigured } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => isRedisConfigured()).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError when checking a malformed Redis URL', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'not-a-url');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', makeTestSecret('redis'));
    const { isRedisConfigured } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => isRedisConfigured()).toThrow(ConfigurationError);
  });

  it('accepts LOGGER_PRETTY as a legacy console mirror alias', async () => {
    vi.stubEnv('LOGGER_CONSOLE_MIRROR', undefined);
    vi.stubEnv('LOGGER_PRETTY', 'false');
    const { getLoggerConfig } =
      await import('@/modules/kernel/infrastructure/config/logger');

    expect(getLoggerConfig().consoleMirror).toBe(false);
  });

  it('prefers LOGGER_CONSOLE_MIRROR over legacy LOGGER_PRETTY', async () => {
    vi.stubEnv('LOGGER_CONSOLE_MIRROR', 'true');
    vi.stubEnv('LOGGER_PRETTY', 'false');
    const { getLoggerConfig } =
      await import('@/modules/kernel/infrastructure/config/logger');

    expect(getLoggerConfig().consoleMirror).toBe(true);
  });

  it('requires an OpenTelemetry Collector URL in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OTEL_COLLECTOR_URL', undefined);
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getTelemetryConfig()).toThrow(ConfigurationError);
    expect(() => getTelemetryConfig()).toThrow('OTEL_COLLECTOR_URL');
  });

  it('accepts production telemetry config when the Collector URL is present', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OTEL_COLLECTOR_URL', 'https://collector.example/v1');
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');

    expect(getTelemetryConfig().collectorUrl).toBe(
      'https://collector.example/v1'
    );
  });

  it('rejects cleartext production OpenTelemetry collector URLs outside localhost', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OTEL_COLLECTOR_URL', 'http://collector.example/v1');
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getTelemetryConfig()).toThrow(ConfigurationError);
    expect(() => getTelemetryConfig()).toThrow('OTEL_COLLECTOR_URL');
  });

  it('accepts cleartext production OpenTelemetry collector URLs for IPv6 loopback', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OTEL_COLLECTOR_URL', 'http://[::1]:4318/v1/traces');
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');

    expect(getTelemetryConfig().collectorUrl).toBe(
      'http://[::1]:4318/v1/traces'
    );
  });

  it('rejects cleartext production S3 transport for non-local storage hosts', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('S3_ACCESS_KEY_ID', makeTestSecret('s3-access-key'));
    vi.stubEnv('S3_SECRET_ACCESS_KEY', makeTestSecret('s3-secret-key'));
    vi.stubEnv('S3_HOST', 'storage.example.com');
    vi.stubEnv('S3_SECURE', 'false');
    const { getStorageConfig } =
      await import('@/modules/kernel/infrastructure/config/storage');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getStorageConfig()).toThrow(ConfigurationError);
    expect(() => getStorageConfig()).toThrow('S3_SECURE');
  });

  it.each([
    '[::1]:9000',
    '::1:9000',
    '::1',
    '::1/uploads',
    'http://[::1]:9000',
  ])(
    'accepts cleartext production S3 transport for IPv6 loopback host %s',
    async (host) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('S3_ACCESS_KEY_ID', makeTestSecret('s3-access-key'));
      vi.stubEnv('S3_SECRET_ACCESS_KEY', makeTestSecret('s3-secret-key'));
      vi.stubEnv('S3_HOST', host);
      vi.stubEnv('S3_SECURE', 'false');
      const { getStorageConfig } =
        await import('@/modules/kernel/infrastructure/config/storage');

      expect(getStorageConfig()).toMatchObject({
        host,
        secure: false,
      });
    }
  );

  it('rejects cleartext production S3 transport for non-loopback IPv6 hosts', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('S3_ACCESS_KEY_ID', makeTestSecret('s3-access-key'));
    vi.stubEnv('S3_SECRET_ACCESS_KEY', makeTestSecret('s3-secret-key'));
    vi.stubEnv('S3_HOST', '2001:db8::1');
    vi.stubEnv('S3_SECURE', 'false');
    const { getStorageConfig } =
      await import('@/modules/kernel/infrastructure/config/storage');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getStorageConfig()).toThrow(ConfigurationError);
    expect(() => getStorageConfig()).toThrow('S3_SECURE');
  });

  it('rejects cleartext production S3 transport when the storage host is malformed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('S3_ACCESS_KEY_ID', makeTestSecret('s3-access-key'));
    vi.stubEnv('S3_SECRET_ACCESS_KEY', makeTestSecret('s3-secret-key'));
    vi.stubEnv('S3_HOST', 'http://[');
    vi.stubEnv('S3_SECURE', 'false');
    const { getStorageConfig } =
      await import('@/modules/kernel/infrastructure/config/storage');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getStorageConfig()).toThrow(ConfigurationError);
    expect(() => getStorageConfig()).toThrow('S3_SECURE');
  });

  it('rejects placeholder production S3 credentials', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('S3_ACCESS_KEY_ID', 'startui-access-key');
    vi.stubEnv('S3_SECRET_ACCESS_KEY', makeTestSecret('s3-secret-key'));
    vi.stubEnv('S3_HOST', 'storage.example.com');
    vi.stubEnv('S3_SECURE', 'true');
    const { getStorageConfig } =
      await import('@/modules/kernel/infrastructure/config/storage');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getStorageConfig()).toThrow(ConfigurationError);
    expect(() => getStorageConfig()).toThrow('S3_ACCESS_KEY_ID');
  });

  it('defaults the Resend webhook body limit to one megabyte', async () => {
    vi.stubEnv('RESEND_API_KEY', makeTestSecret('resend-api-key'));
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('RESEND_WEBHOOK_MAX_BYTES', undefined);
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');

    expect(getEmailConfig().resendWebhookMaxBytes).toBe(1_000_000);
  });

  it('parses an explicit Resend webhook body limit', async () => {
    vi.stubEnv('RESEND_API_KEY', makeTestSecret('resend-api-key'));
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('RESEND_WEBHOOK_MAX_BYTES', '4096');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');

    expect(getEmailConfig().resendWebhookMaxBytes).toBe(4096);
  });

  it('parses an explicit SMTP email server', async () => {
    vi.stubEnv('RESEND_API_KEY', makeTestSecret('resend-api-key'));
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('EMAIL_SERVER', 'smtp://127.0.0.1:1025');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');

    expect(getEmailConfig().server).toBe('smtp://127.0.0.1:1025');
  });

  it('does not require Resend credentials for SMTP email delivery', async () => {
    vi.stubEnv('RESEND_API_KEY', undefined);
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('EMAIL_SERVER', 'smtp://127.0.0.1:1025');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');

    expect(getEmailConfig()).toMatchObject({
      resendApiKey: undefined,
      server: 'smtp://127.0.0.1:1025',
    });
  });

  it('requires Resend credentials when SMTP email delivery is not configured', async () => {
    vi.stubEnv('RESEND_API_KEY', undefined);
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getEmailConfig()).toThrow(ConfigurationError);
    expect(() => getEmailConfig()).toThrow('RESEND_API_KEY');
  });

  it('rejects unsupported email server protocols', async () => {
    vi.stubEnv('RESEND_API_KEY', makeTestSecret('resend-api-key'));
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('EMAIL_SERVER', 'https://mail.example.com');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getEmailConfig()).toThrow(ConfigurationError);
    expect(() => getEmailConfig()).toThrow('EMAIL_SERVER');
  });

  it('rejects SMTP email server configuration in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RESEND_API_KEY', makeTestSecret('resend-api-key'));
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('EMAIL_SERVER', 'smtp://127.0.0.1:1025');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getEmailConfig()).toThrow(ConfigurationError);
    expect(() => getEmailConfig()).toThrow('EMAIL_SERVER');
  });

  it('rejects placeholder production Resend webhook secrets', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RESEND_API_KEY', makeTestSecret('resend-api-key'));
    vi.stubEnv('RESEND_WEBHOOK_SECRET', 'REPLACE ME');
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getEmailConfig()).toThrow(ConfigurationError);
    expect(() => getEmailConfig()).toThrow('RESEND_WEBHOOK_SECRET');
  });

  it('rejects cleartext production node-pg database URLs', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl({ host: 'db.example.com' }));
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getDatabaseConfig()).toThrow(ConfigurationError);
    expect(() => getDatabaseConfig()).toThrow('DATABASE_URL');
  });

  it('accepts production node-pg database URLs with a secure sslmode', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const databaseUrl = makeTestDatabaseUrl({
      host: 'db.example.com',
      searchParams: { sslmode: 'verify-full' },
    });
    vi.stubEnv('DATABASE_URL', databaseUrl);
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getDatabaseConfig().databaseUrl).toBe(databaseUrl);
  });

  it('accepts cleartext production database URLs that target localhost', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const databaseUrl = makeTestDatabaseUrl();
    vi.stubEnv('DATABASE_URL', databaseUrl);
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getDatabaseConfig().databaseUrl).toBe(databaseUrl);
  });

  it('exempts Neon drivers from the production database TLS requirement', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const databaseUrl = makeTestDatabaseUrl({ host: 'db.example.com' });
    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv('DATABASE_DRIVER', 'neon-websocket');
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getDatabaseConfig().databaseUrl).toBe(databaseUrl);
  });

  it('rejects cleartext production migration database URLs', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    vi.stubEnv(
      'DATABASE_MIGRATION_URL',
      makeTestDatabaseUrl({ host: 'db.example.com' })
    );
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getMigrationDatabaseConfig()).toThrow(ConfigurationError);
    expect(() => getMigrationDatabaseConfig()).toThrow(
      'DATABASE_MIGRATION_URL'
    );
  });

  it('rejects cleartext production Redis REST URLs outside localhost', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'http://redis.example.com');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', makeTestSecret('redis'));
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getRedisConfig()).toThrow(ConfigurationError);
    expect(() => getRedisConfig()).toThrow('UPSTASH_REDIS_REST_URL');
  });

  it('defaults the trusted proxy depth to one hop', async () => {
    vi.stubEnv('TRUSTED_PROXY_DEPTH', undefined);
    const { getHttpConfig } =
      await import('@/modules/kernel/infrastructure/config/http');

    expect(getHttpConfig().trustedProxyDepth).toBe(1);
  });

  it('parses an explicit positive trusted proxy depth', async () => {
    vi.stubEnv('TRUSTED_PROXY_DEPTH', '2');
    const { getHttpConfig } =
      await import('@/modules/kernel/infrastructure/config/http');

    expect(getHttpConfig().trustedProxyDepth).toBe(2);
  });

  it('treats an empty trusted proxy depth as unset', async () => {
    vi.stubEnv('TRUSTED_PROXY_DEPTH', '   ');
    const { getHttpConfig } =
      await import('@/modules/kernel/infrastructure/config/http');

    expect(getHttpConfig().trustedProxyDepth).toBe(1);
  });

  it('rejects zero as a trusted proxy depth', async () => {
    vi.stubEnv('TRUSTED_PROXY_DEPTH', '0');
    const { getHttpConfig } =
      await import('@/modules/kernel/infrastructure/config/http');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getHttpConfig()).toThrow(ConfigurationError);
  });

  it('rejects a negative trusted proxy depth', async () => {
    vi.stubEnv('TRUSTED_PROXY_DEPTH', '-1');
    const { getHttpConfig } =
      await import('@/modules/kernel/infrastructure/config/http');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getHttpConfig()).toThrow(ConfigurationError);
  });

  it('defaults telemetry proxy auth to disabled', async () => {
    vi.stubEnv('TELEMETRY_REQUIRE_AUTH', undefined);
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');

    expect(getTelemetryConfig().requireAuth).toBe(false);
  });

  it('parses an explicit telemetry proxy auth requirement', async () => {
    vi.stubEnv('TELEMETRY_REQUIRE_AUTH', 'true');
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');

    expect(getTelemetryConfig().requireAuth).toBe(true);
  });

  it('rejects cleartext production Sentry DSNs outside localhost', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OTEL_COLLECTOR_URL', 'https://collector.example/v1');
    vi.stubEnv('SENTRY_DSN', 'http://public@sentry.example.com/1');
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getTelemetryConfig()).toThrow(ConfigurationError);
    expect(() => getTelemetryConfig()).toThrow('SENTRY_DSN');
  });
});
