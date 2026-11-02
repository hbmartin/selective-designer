import { makeTestDatabaseUrl } from '@tests/server/test-database-url';
import { makeShortTestSecret } from '@tests/support/test-secrets';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ConfigurationError } from '@/modules/kernel/domain/errors/configuration-error';
import {
  baseEnvSchema,
  getSeedAccountEmails,
  isProdRuntimeEnvironment,
  parseEnv,
} from '@/modules/kernel/infrastructure/config/env-schema';

function captureThrown(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return error;
  }

  throw new Error('Expected function to throw.');
}

describe('server env parser', () => {
  it('returns parsed values and allows unknown variables', () => {
    const schema = baseEnvSchema.extend({
      DATABASE_URL: z.url(),
    });
    const databaseUrl = makeTestDatabaseUrl();

    expect(
      parseEnv(schema, {
        DATABASE_URL: databaseUrl,
        EXTRA_VALUE: 'kept',
      })
    ).toMatchObject({
      DATABASE_URL: databaseUrl,
      EXTRA_VALUE: 'kept',
    });
  });

  it('throws ConfigurationError for missing required values', () => {
    expect(() =>
      parseEnv(baseEnvSchema.extend({ DATABASE_URL: z.url() }), {})
    ).toThrow(ConfigurationError);
  });

  it('includes failing field names without exposing secret values', () => {
    const schema = baseEnvSchema.extend({
      SECRET_TOKEN: z.string().min(32),
      SERVICE_URL: z.url(),
    });
    const secret = makeShortTestSecret('env');

    const error = captureThrown(() =>
      parseEnv(schema, {
        SECRET_TOKEN: secret,
        SERVICE_URL: 'not-a-url',
      })
    );

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      message: expect.stringContaining('SECRET_TOKEN'),
    });
    expect(error).toMatchObject({
      message: expect.stringContaining('SERVICE_URL'),
    });
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).cause).toBeInstanceOf(z.ZodError);
  });
});

describe('isProdRuntimeEnvironment (fail-closed production detection)', () => {
  it('treats a production build artifact as production', () => {
    expect(isProdRuntimeEnvironment({ PROD: true })).toBe(true);
    expect(isProdRuntimeEnvironment({ NODE_ENV: 'production' })).toBe(true);
  });

  it('does NOT let a non-allowlisted NODE_ENV downgrade a production build', () => {
    // The split-brain bug: a prod build run with NODE_ENV=staging must still be
    // treated as production so DB-TLS / secret guards stay enforced.
    expect(isProdRuntimeEnvironment({ NODE_ENV: 'staging', PROD: true })).toBe(
      true
    );
    expect(isProdRuntimeEnvironment({ NODE_ENV: 'preview', PROD: true })).toBe(
      true
    );
  });

  it('only downgrades to non-production via the explicit development/test allowlist', () => {
    expect(
      isProdRuntimeEnvironment({ NODE_ENV: 'development', PROD: true })
    ).toBe(false);
    expect(isProdRuntimeEnvironment({ NODE_ENV: 'test', PROD: true })).toBe(
      false
    );
  });

  it('is non-production when there is no production signal at all', () => {
    expect(isProdRuntimeEnvironment({})).toBe(false);
    expect(isProdRuntimeEnvironment({ PROD: false })).toBe(false);
    expect(isProdRuntimeEnvironment({ NODE_ENV: 'staging' })).toBe(false);
  });
});

describe('seed account email config', () => {
  it('uses stable local defaults when seed email overrides are absent', () => {
    expect(getSeedAccountEmails({})).toEqual({
      adminEmail: 'admin@e2e.local',
      userEmail: 'user@e2e.local',
    });
  });

  it('normalizes explicit seed email overrides', () => {
    expect(
      getSeedAccountEmails({
        SEED_ADMIN_EMAIL: ' Admin@E2E.Local ',
        SEED_USER_EMAIL: ' User@E2E.Local ',
      })
    ).toEqual({
      adminEmail: 'admin@e2e.local',
      userEmail: 'user@e2e.local',
    });
  });

  it('rejects malformed seed email overrides', () => {
    expect(() =>
      getSeedAccountEmails({
        SEED_ADMIN_EMAIL: 'not-an-email',
      })
    ).toThrow(ConfigurationError);
  });
});
