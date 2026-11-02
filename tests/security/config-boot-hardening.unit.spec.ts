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
describe('validateServerConfig fails closed on insecure production config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('SKIP_ENV_VALIDATION', undefined);
  });

  it('throws ConfigurationError in production when AUTH_SECRET is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_SECRET', undefined);

    const { ConfigurationError } = await import('@/modules/kernel');
    const { validateServerConfig } = await import('@/modules/kernel/backend');

    expect(() => validateServerConfig()).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError in production for a cleartext database URL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_SECRET', makeStrongTestSecret('auth'));
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl({ host: 'db.example.com' }));

    const { ConfigurationError } = await import('@/modules/kernel');
    const { validateServerConfig } = await import('@/modules/kernel/backend');

    expect(() => validateServerConfig()).toThrow(ConfigurationError);
    expect(() => validateServerConfig()).toThrow('DATABASE_URL');
  });

  it('is a no-op when env validation is skipped outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
    vi.stubEnv('AUTH_SECRET', undefined);
    vi.stubEnv('DATABASE_URL', undefined);

    const { validateServerConfig } = await import('@/modules/kernel/backend');

    expect(() => validateServerConfig()).not.toThrow();
  });
});

/**
 * The hardened OTP brute-force cap (M1). Better Auth's email-OTP `allowedAttempts`
 * is sourced from this value, so the default must stay at the hardened 3 and the
 * field must remain wired from `AUTH_OTP_ALLOWED_ATTEMPTS`.
 */
describe('Better Auth OTP attempt cap default', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('SKIP_ENV_VALIDATION', undefined);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', makeStrongTestSecret('auth'));
  });

  it('defaults otpAllowedAttempts to the hardened value of 3', async () => {
    vi.stubEnv('AUTH_OTP_ALLOWED_ATTEMPTS', undefined);

    const { getBetterAuthConfig } = await import('@/modules/kernel/backend');
    const config = getBetterAuthConfig();

    expect(config).toHaveProperty('otpAllowedAttempts', 3);
    expect(typeof config.otpAllowedAttempts).toBe('number');
  });

  it('wires otpAllowedAttempts from AUTH_OTP_ALLOWED_ATTEMPTS', async () => {
    vi.stubEnv('AUTH_OTP_ALLOWED_ATTEMPTS', '5');

    const { getBetterAuthConfig } = await import('@/modules/kernel/backend');

    expect(getBetterAuthConfig().otpAllowedAttempts).toBe(5);
  });
});
