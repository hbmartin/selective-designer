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
  }
);
