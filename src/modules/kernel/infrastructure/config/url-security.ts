import { isProdRuntimeEnvironment } from './env-schema';
import { ConfigurationError } from '../../domain/errors/configuration-error';

type RuntimeEnv = Record<string, unknown>;

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * PostgreSQL sslmode values that negotiate *authenticated* TLS — the server
 * certificate and hostname are verified, defeating MITM. `require` only
 * encrypts without verifying the server identity; `disable`, `allow`, and
 * `prefer` (the libpq/node-pg default when sslmode is absent) may transmit
 * credentials and data in cleartext. All of these are rejected in production.
 */
const SECURE_SSL_MODES = new Set(['verify-ca', 'verify-full']);

/** URL schemes that are unambiguously cleartext for a database connection. */
const CLEARTEXT_DB_SCHEMES = new Set(['http:', 'ws:']);

const stripIpv6Brackets = (value: string) =>
  value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;

/**
 * True when the URL points at the loopback host. Mirrors the localhost
 * allowance used by the telemetry and storage guards so local development and
 * CI can keep using plain `http://` / `postgres://` connections.
 */
export const isLocalhostUrl = (value: string): boolean => {
  try {
    return LOCALHOST_HOSTNAMES.has(stripIpv6Brackets(new URL(value).hostname));
  } catch {
    return false;
  }
};

/**
 * Rejects cleartext URLs in production. No-op when the value is absent, the
 * runtime is non-production, the host is localhost, or the URL is malformed
 * (malformed URLs are surfaced by the schema's own `url()` validation).
 */
export const assertSecureUrlInProduction = ({
  name,
  value,
  env,
}: {
  name: string;
  value: string | undefined;
  env?: RuntimeEnv;
}): void => {
  if (!value) return;
  if (!isProdRuntimeEnvironment(env)) return;
  if (isLocalhostUrl(value)) return;

  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    return;
  }

  if (protocol !== 'https:') {
    throw new ConfigurationError(
      `${name} must use HTTPS in production unless it targets localhost.`
    );
  }
};

/**
 * Rejects cleartext / unauthenticated-TLS database connections in production,
 * for every driver — no driver is blanket-exempt (CWE-183).
 *
 * - All drivers: an explicitly cleartext scheme (`http://`, `ws://`) or
 *   `sslmode=disable` is rejected.
 * - `node-pg`: the URL carries the TLS decision, so it must request an
 *   *authenticated* sslmode (`verify-ca` / `verify-full`). `require` only
 *   encrypts without verifying the server certificate and is not accepted.
 * - `neon-http` / `neon-websocket`: TLS is negotiated inside the Neon driver
 *   (secure-by-default) from a `postgres://` connection string, so beyond the
 *   cleartext sanity checks above there is no URL-level sslmode to enforce.
 *
 * No-op for non-production runtimes, localhost hosts, or malformed URLs
 * (malformed URLs are surfaced by the schema's own `url()` validation).
 */
export const assertDatabaseUrlTls = ({
  name,
  url,
  driver,
  env,
}: {
  name: string;
  url: string;
  driver: string;
  env?: RuntimeEnv;
}): void => {
  if (!isProdRuntimeEnvironment(env)) return;
  if (isLocalhostUrl(url)) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }

  if (CLEARTEXT_DB_SCHEMES.has(parsed.protocol)) {
    throw new ConfigurationError(
      `${name} must not use a cleartext (${parsed.protocol}) URL in production.`
    );
  }

  const sslmodes = parsed.searchParams
    .getAll('sslmode')
    .map((value) => value.toLowerCase());

  if (sslmodes.includes('disable')) {
    throw new ConfigurationError(
      `${name} must not set sslmode=disable in production.`
    );
  }

  if (driver === 'neon-http' || driver === 'neon-websocket') {
    return;
  }

  const [sslmode] = sslmodes;
  if (sslmodes.length !== 1 || !sslmode || !SECURE_SSL_MODES.has(sslmode)) {
    throw new ConfigurationError(
      `${name} must enable authenticated TLS in production: set sslmode=verify-full ` +
        `(recommended) or sslmode=verify-ca. sslmode=require only encrypts without ` +
        `verifying the server certificate; disable/allow/prefer transmit credentials in cleartext.`
    );
  }
};
