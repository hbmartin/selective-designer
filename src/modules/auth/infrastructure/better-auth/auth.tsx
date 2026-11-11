import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, openAPI } from 'better-auth/plugins';
import { tanstackStartCookies } from 'better-auth/tanstack-start';
import { eq } from 'drizzle-orm';

import { isProdRuntimeEnvironment } from '@/modules/kernel/backend';
import { getBetterAuthConfig } from '@/modules/kernel/infrastructure/config/auth';
import {
  type Database,
  getDefaultDbClient,
} from '@/modules/kernel/infrastructure/db/client';
import { envClient } from '@/platform/env/client';

import { OPERATOR_ONLY_AUTH_PATHS } from './auth-http-exposure';
import { createAuthCookieSecurityOptions } from './cookie-options';
import {
  type CreateAuthOptions,
  normalizeCreateAuthInput,
} from './create-auth-options';
import { createCredentialVersionCache } from './credential-version-cache';
import {
  createCredentialVersionHooks,
  credentialVersionField,
} from './credential-version-hooks';
import { betterAuthPermissions } from './permissions';
import { user } from './schema';
import { createBetterAuthSecondaryStorage } from './secondary-storage-adapter';
import { InMemorySecondaryStore } from '../secondary-store/in-memory-secondary-store';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../domain/password-policy';

export function createAuth(input?: Database | CreateAuthOptions) {
  const options = normalizeCreateAuthInput(input);
  const database = options.database ?? getDefaultDbClient();
  const secondaryStore = options.secondaryStore ?? new InMemorySecondaryStore();
  const validateVersion = createCredentialVersionCache(async (userId) => {
    const [row] = await database
      .select({ version: user.credentialVersion })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.version;
  }, options.credentialVersionClock);
  const secondaryStorage = createBetterAuthSecondaryStorage(
    secondaryStore,
    validateVersion
  );
  const authConfig = getBetterAuthConfig();

  return betterAuth({
    ...createCredentialVersionHooks(database),
    disabledPaths: [...OPERATOR_ONLY_AUTH_PATHS, '/reset-password/:token'],
    secret: authConfig.secret,
    baseURL: {
      allowedHosts: [
        new URL(envClient.VITE_BASE_URL).host,
        ...(authConfig.allowedHosts ?? []),
      ],
    },
    secondaryStorage,
    rateLimit: {
      enabled: true,
      storage: 'secondary-storage',
      window: authConfig.rateLimitWindowSeconds,
      max: authConfig.rateLimitMax,
    },
    session: {
      // Secondary storage is the common validation boundary for all session reads.
      cookieCache: { enabled: false },
      storeSessionInDatabase: false,
      additionalFields: { credentialVersion: credentialVersionField },
      expiresIn: authConfig.sessionExpirationInSeconds,
      updateAge: authConfig.sessionUpdateAgeInSeconds,
      freshAge: authConfig.sessionFreshAgeInSeconds,
    },
    advanced: createAuthCookieSecurityOptions(envClient.VITE_BASE_URL, {
      isProduction: isProdRuntimeEnvironment(),
    }),
    account: {
      encryptOAuthTokens: true,
    },
    trustedOrigins: authConfig.trustedOrigins,
    database: drizzleAdapter(database, {
      provider: 'pg',
    }),
    user: {
      additionalFields: {
        credentialVersion: credentialVersionField,
        onboardedAt: {
          type: 'date',
          // Server-managed workflow flag. `input: false` keeps it out of Better
          // Auth's user-writable input, so a caller cannot self-set it via
          // `POST /api/auth/update-user` to skip onboarding. The onboarding use
          // case writes it directly through the repository. (CWE-915 / CWE-841.)
          input: false,
        },
      },
    },
    onAPIError: {
      throw: true,
      errorURL: '/login/error',
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },

    plugins: [
      openAPI({
        disableDefaultReference: true,
      }),
      admin({
        ...betterAuthPermissions,
      }),
      tanstackStartCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let defaultAuth: Auth | undefined;

export function getDefaultAuth() {
  defaultAuth ??= createAuth();
  return defaultAuth;
}

export const auth = new Proxy({} as Auth, {
  get(_target, prop) {
    const instance = getDefaultAuth();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});
