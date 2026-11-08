import { makeTestDatabaseUrl } from '@tests/server/test-database-url';
import { makeStrongTestSecret } from '@tests/support/test-secrets';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression guardrails for the fail-closed boot path.
 *
 * `src/server.ts` calls `validateServerConfig()` (re-exported from the kernel
 * public gate `@/modules/kernel/backend`) at module load, so an insecure
 * production environment must abort the boot with a `ConfigurationError` rather
 * than start serving. These tests pin that behaviour through the public gate and
 * the no-op escape hatch used by local dev / CI.
 *
 * Env is mutated with `vi.stubEnv` per the config-accessors.unit.spec.ts
 * pattern; `vi.resetModules()` clears the module-level config caches between
 * cases so each import re-parses the stubbed environment.
 */
describe.each(['validateServerConfig', 'validateServerBuildConfig'] as const)(
  '%s fails closed on insecure production config',
  (validator) => {
    beforeEach(() => {
      vi.resetModules();
      vi.unstubAllEnvs();
      vi.stubEnv('SKIP_ENV_VALIDATION', undefined);
      vi.stubEnv('CRON_SECRET', makeStrongTestSecret('cron'));
    });

    it('throws ConfigurationError in production when AUTH_SECRET is missing', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AUTH_SECRET', undefined);
      vi.stubEnv('PROVIDER_MODE', 'live');
      vi.stubEnv('FAL_KEY', undefined);
      vi.stubEnv('BFL_API_KEY', undefined);

      const { ConfigurationError } = await import('@/modules/kernel');
      const validate = (await import('@/modules/kernel/backend'))[validator];

      expect(() => validate()).toThrow(ConfigurationError);
      expect(() => validate()).toThrow(/AUTH_SECRET/u);
    });

    it('throws ConfigurationError in production for a cleartext database URL', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AUTH_SECRET', makeStrongTestSecret('auth'));
      vi.stubEnv(
        'DATABASE_URL',
        makeTestDatabaseUrl({ host: 'db.example.com' })
      );

      const { ConfigurationError } = await import('@/modules/kernel');
      const validate = (await import('@/modules/kernel/backend'))[validator];

      expect(() => validate()).toThrow(ConfigurationError);
      expect(() => validate()).toThrow('DATABASE_URL');
    });

    it('is a no-op when env validation is skipped outside production', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
      vi.stubEnv('AUTH_SECRET', undefined);
      vi.stubEnv('DATABASE_URL', undefined);

      const validate = (await import('@/modules/kernel/backend'))[validator];

      expect(() => validate()).not.toThrow();
    });

    it('accepts production configuration without email services or a telemetry collector', async () => {
      for (const key of [
        'RESEND_API_KEY',
        'RESEND_WEBHOOK_SECRET',
        'RESEND_WEBHOOK_MAX_BYTES',
        'EMAIL_SERVER',
        'EMAIL_FROM',
        'EMAIL_DELIVERY_DISABLED',
      ]) {
        vi.stubEnv(key, undefined);
      }
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AUTH_SECRET', makeStrongTestSecret('auth'));
      vi.stubEnv('DATABASE_DRIVER', 'node-pg');
      vi.stubEnv(
        'DATABASE_URL',
        `${makeTestDatabaseUrl()}?sslmode=verify-full`
      );
      vi.stubEnv('S3_ACCESS_KEY_ID', makeStrongTestSecret('s3-access'));
      vi.stubEnv('S3_SECRET_ACCESS_KEY', makeStrongTestSecret('s3-secret'));
      vi.stubEnv('S3_HOST', 'storage.example.com');
      vi.stubEnv('S3_SECURE', 'true');
      vi.stubEnv('PROVIDER_MODE', 'live');
      vi.stubEnv('FAL_KEY', makeStrongTestSecret('fal'));
      vi.stubEnv('BFL_API_KEY', makeStrongTestSecret('bfl'));
      vi.stubEnv('OTEL_COLLECTOR_URL', undefined);

      const validate = (await import('@/modules/kernel/backend'))[validator];

      expect(() => validate()).not.toThrow();
    });
  }
);
