/* oxlint-disable no-process-env */
import { join, map, pipe, unique } from 'remeda';
import { z } from 'zod';

import { ConfigurationError } from '../../domain/errors/configuration-error';

type RuntimeEnv = Record<string, unknown>;

const runtimeEnv = (): RuntimeEnv => ({
  ...(typeof process === 'undefined' ? {} : process.env),
  ...(import.meta as ImportMeta & { env?: RuntimeEnv }).env,
});

const isTruthy = (value: unknown) => value === true || value === 'true';

const seedEmailOverrideSchema = z
  .preprocess(
    (value) => (typeof value === 'string' ? value.trim() : undefined),
    z.union([z.literal(''), z.email()]).optional()
  )
  .transform((value) => (value ? value.toLowerCase() : undefined));

const seedAccountEmailEnvSchema = z
  .object({
    SEED_ADMIN_EMAIL: seedEmailOverrideSchema,
    SEED_USER_EMAIL: seedEmailOverrideSchema,
  })
  .passthrough();

const DEFAULT_SEED_ACCOUNT_EMAILS = {
  adminEmail: 'admin@e2e.local',
  userEmail: 'user@e2e.local',
} as const;

/**
 * Canonical, fail-closed "is this a production runtime" check. Every
 * security-relevant guard (DB/URL TLS enforcement, secret-placeholder
 * rejection, secure cookies, HSTS, telemetry transport) MUST derive
 * "is production" from here so there is a single, consistent notion of prod.
 *
 * A production build artifact (`import.meta.env.PROD === true`) is
 * authoritative. `NODE_ENV` may only DOWNGRADE it to non-prod, and only via an
 * explicit `development`/`test` allowlist. Any other `NODE_ENV` value (e.g.
 * `staging`, `preview`) must NOT silently disable production guards, so an
 * unrecognized value falls back to the build-time `PROD` signal rather than
 * being treated as non-prod. This prevents the split-brain where a prod build
 * run with `NODE_ENV=staging` kept HSTS on but dropped DB-TLS verification.
 */
export const isProdRuntimeEnvironment = (source?: RuntimeEnv) => {
  const env = source ?? runtimeEnv();
  const nodeEnv =
    typeof env.NODE_ENV === 'string'
      ? env.NODE_ENV.trim().toLowerCase()
      : undefined;
  if (nodeEnv === 'development' || nodeEnv === 'test') return false;
  if (nodeEnv === 'production') return true;
  return isTruthy(env.PROD);
};

export const isDevRuntimeEnvironment = (source?: RuntimeEnv) => {
  const env = source ?? runtimeEnv();
  return env.NODE_ENV ? env.NODE_ENV === 'development' : isTruthy(env.DEV);
};

export const shouldSkipEnvValidation = (source?: RuntimeEnv) => {
  const env = source ?? runtimeEnv();
  return isTruthy(env.SKIP_ENV_VALIDATION) && !isProdRuntimeEnvironment(env);
};

/**
 * Explicit opt-in (ALLOW_PROD_SEED=true) required to run the database seed
 * against a production environment. Used by the seed entrypoint to avoid
 * planting demo accounts in production.
 */
export const isProductionSeedAllowed = (source?: RuntimeEnv) =>
  isTruthy((source ?? runtimeEnv()).ALLOW_PROD_SEED);

/**
 * Optional explicit seed-account emails (SEED_ADMIN_EMAIL / SEED_USER_EMAIL).
 * When unset, stable local defaults keep `db:seed` idempotent across reruns.
 * Resolved here in kernel config so seed scripts avoid raw `process.env`
 * access.
 */
export const getSeedAccountEmails = (source?: RuntimeEnv) => {
  const env = source ?? runtimeEnv();
  const parsed = parseEnv(seedAccountEmailEnvSchema, env);

  return {
    adminEmail:
      parsed.SEED_ADMIN_EMAIL ?? DEFAULT_SEED_ACCOUNT_EMAILS.adminEmail,
    userEmail: parsed.SEED_USER_EMAIL ?? DEFAULT_SEED_ACCOUNT_EMAILS.userEmail,
  };
};

export const zNonEmptyEnvString = () => z.string().trim().min(1);

export const baseEnvSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    VERCEL_ENV: z.string().optional(),
  })
  .passthrough();

const fieldNameFromIssue = (issue: z.ZodIssue) =>
  issue.path.length ? issue.path.map(String).join('.') : 'environment';

export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  source?: Record<string, unknown>
): z.infer<TSchema> {
  const result = schema.safeParse(source ?? runtimeEnv());
  if (result.success) return result.data;

  const issues = pipe(
    result.error.issues,
    map((issue) => ({
      field: fieldNameFromIssue(issue),
      message: issue.message,
    }))
  );
  const fields = pipe(
    issues,
    map((issue) => issue.field),
    unique(),
    join(', ')
  );

  throw new ConfigurationError(`Invalid environment configuration: ${fields}`, {
    details: { issues },
    cause: result.error,
  });
}
