import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '@/modules/kernel/domain/errors/configuration-error';
import {
  assertDatabaseUrlTls,
  assertSecureUrlInProduction,
  isLocalhostUrl,
} from '@/modules/kernel/infrastructure/config/url-security';

const PROD = { NODE_ENV: 'production' };
const DEV = { NODE_ENV: 'development' };

describe('isLocalhostUrl', () => {
  it('detects loopback hosts across schemes', () => {
    expect(isLocalhostUrl('http://localhost:3000')).toBe(true);
    expect(isLocalhostUrl('http://127.0.0.1:9000/default')).toBe(true);
    expect(isLocalhostUrl('http://[::1]:4318/v1')).toBe(true);
    expect(isLocalhostUrl('postgres://user@localhost:5432/app')).toBe(true);
  });

  it('returns false for remote hosts and malformed URLs', () => {
    expect(isLocalhostUrl('https://example.com')).toBe(false);
    expect(isLocalhostUrl('postgres://user@db.example.com/app')).toBe(false);
    expect(isLocalhostUrl('not-a-url')).toBe(false);
  });
});

describe('assertSecureUrlInProduction', () => {
  it('rejects cleartext production URLs for remote hosts', () => {
    expect(() =>
      assertSecureUrlInProduction({
        name: 'SENTRY_DSN',
        value: 'http://sentry.example.com/1',
        env: PROD,
      })
    ).toThrow(ConfigurationError);
  });

  it('allows https, localhost, absent values, and non-production', () => {
    expect(() =>
      assertSecureUrlInProduction({
        name: 'X',
        value: 'https://example.com',
        env: PROD,
      })
    ).not.toThrow();
    expect(() =>
      assertSecureUrlInProduction({
        name: 'X',
        value: 'http://localhost:1234',
        env: PROD,
      })
    ).not.toThrow();
    expect(() =>
      assertSecureUrlInProduction({ name: 'X', value: undefined, env: PROD })
    ).not.toThrow();
    expect(() =>
      assertSecureUrlInProduction({
        name: 'X',
        value: 'http://example.com',
        env: DEV,
      })
    ).not.toThrow();
  });
});

describe('assertDatabaseUrlTls', () => {
  const remote = (sslmode?: string) =>
    `postgres://user@db.example.com:5432/app${sslmode ? `?sslmode=${sslmode}` : ''}`;

  it.each(['verify-ca', 'verify-full', 'Verify-CA', 'Verify-Full'])(
    'accepts production node-pg URLs with authenticated sslmode=%s',
    (mode) => {
      expect(() =>
        assertDatabaseUrlTls({
          name: 'DATABASE_URL',
          url: remote(mode),
          driver: 'node-pg',
          env: PROD,
        })
      ).not.toThrow();
    }
  );

  it.each([undefined, 'require', 'REQUIRE', 'prefer', 'disable', 'allow'])(
    'rejects production node-pg URLs with unauthenticated sslmode=%s',
    (mode) => {
      expect(() =>
        assertDatabaseUrlTls({
          name: 'DATABASE_URL',
          url: remote(mode),
          driver: 'node-pg',
          env: PROD,
        })
      ).toThrow(ConfigurationError);
    }
  );

  it('rejects production node-pg URLs with duplicate sslmode values', () => {
    expect(() =>
      assertDatabaseUrlTls({
        name: 'DATABASE_URL',
        url: remote('verify-full&sslmode=verify-ca'),
        driver: 'node-pg',
        env: PROD,
      })
    ).toThrow(ConfigurationError);
  });

  describe('Neon drivers are no longer blanket-exempt', () => {
    it.each(['neon-http', 'neon-websocket'])(
      'accepts a normal postgres:// connection string for %s (driver enforces TLS)',
      (driver) => {
        expect(() =>
          assertDatabaseUrlTls({
            name: 'DATABASE_URL',
            url: remote(),
            driver,
            env: PROD,
          })
        ).not.toThrow();
      }
    );

    it.each(['neon-http', 'neon-websocket'])(
      'rejects a cleartext ws:// / sslmode=disable URL for %s',
      (driver) => {
        expect(() =>
          assertDatabaseUrlTls({
            name: 'DATABASE_URL',
            url: 'ws://attacker.example.com/app',
            driver,
            env: PROD,
          })
        ).toThrow(ConfigurationError);
        expect(() =>
          assertDatabaseUrlTls({
            name: 'DATABASE_URL',
            url: remote('disable'),
            driver,
            env: PROD,
          })
        ).toThrow(ConfigurationError);
      }
    );
  });

  it('rejects cleartext http:// / ws:// schemes for node-pg too', () => {
    for (const url of [
      'http://db.example.com/app',
      'ws://db.example.com/app',
    ]) {
      expect(() =>
        assertDatabaseUrlTls({
          name: 'DATABASE_URL',
          url,
          driver: 'node-pg',
          env: PROD,
        })
      ).toThrow(ConfigurationError);
    }
  });

  it('exempts localhost and non-production runtimes', () => {
    expect(() =>
      assertDatabaseUrlTls({
        name: 'DATABASE_URL',
        url: 'postgres://user@localhost:5432/app',
        driver: 'node-pg',
        env: PROD,
      })
    ).not.toThrow();
    expect(() =>
      assertDatabaseUrlTls({
        name: 'DATABASE_URL',
        url: remote('require'),
        driver: 'node-pg',
        env: DEV,
      })
    ).not.toThrow();
  });
});
