import {
  type AuthEmailPort,
  type AuthHttpGateway,
  type AuthorizationGateway,
  createAuthUseCases,
  type SecondaryStore,
  type SessionGateway,
  type UserAdminGateway,
} from '@/modules/auth';
import {
  type Auth,
  createAuth,
} from '@/modules/auth/infrastructure/better-auth/auth';
import { isBlockedBetterAuthHttpPath } from '@/modules/auth/infrastructure/better-auth/auth-http-exposure';
import { AuthorizationGatewayBetterAuth } from '@/modules/auth/infrastructure/better-auth/authorization-gateway-better-auth';
import { SessionGatewayBetterAuth } from '@/modules/auth/infrastructure/better-auth/session-gateway-better-auth';
import { UserAdminGatewayBetterAuth } from '@/modules/auth/infrastructure/better-auth/user-admin-gateway-better-auth';
import { InMemorySecondaryStore } from '@/modules/auth/infrastructure/secondary-store/in-memory-secondary-store';
import { UpstashSecondaryStore } from '@/modules/auth/infrastructure/secondary-store/upstash-secondary-store';
import { ConfigurationError } from '@/modules/kernel';
import {
  createTelemetryLogger,
  getAuthProviderConfig,
  getBetterAuthConfig,
  getRedisConfig,
} from '@/modules/kernel/backend';

import { AuthEmailPortEmailGateway } from './auth-email-port';
import { getEmailGateway } from './email';
import { createCachedFactory } from './shared/singleton';
// Same instance the kernel exposes as `kernel.telemetry`. Sourced from the
// telemetry barrel rather than `getKernel()` to avoid an auth <-> kernel
// composition cycle (kernel dynamically imports this module for permissions).
import { telemetryProxy } from './telemetry';

export type AuthOverrides = {
  sessionGateway?: SessionGateway;
  authorizationGateway?: AuthorizationGateway;
  authEmailPort?: AuthEmailPort;
  userAdminGateway?: UserAdminGateway;
};

type AuthInstanceOverrides = {
  authEmailPort?: AuthEmailPort;
  secondaryStore?: SecondaryStore;
};

type AuthHttpOverrides = AuthInstanceOverrides & {
  authHttpGateway?: AuthHttpGateway;
};

const buildAuthEmailPort = (overrides?: AuthInstanceOverrides) =>
  overrides?.authEmailPort ??
  new AuthEmailPortEmailGateway(
    getEmailGateway(),
    createTelemetryLogger({ telemetry: telemetryProxy })
  );

/**
 * Durable when Upstash Redis is configured, otherwise a per-process map. The
 * map is fine for single-instance deploys; multi-instance/serverless needs the
 * shared Redis backend (or an edge/WAF control) for cross-instance rate limits.
 */
const buildSecondaryStore = (): SecondaryStore => {
  const redisConfig = getRedisConfig();
  return redisConfig
    ? new UpstashSecondaryStore({
        config: redisConfig,
        telemetry: telemetryProxy,
      })
    : new InMemorySecondaryStore();
};

const secondaryStoreFactory = createCachedFactory<SecondaryStore, never>(
  buildSecondaryStore
);

export const getSecondaryStore = () => secondaryStoreFactory.get();

const assertBetterAuthProvider = () => {
  const { provider } = getAuthProviderConfig();
  if (provider !== 'better-auth') {
    throw new ConfigurationError(
      `AUTH_PROVIDER=${provider} is not implemented in this build.`
    );
  }
};

const buildAuth = (overrides?: AuthInstanceOverrides) => {
  assertBetterAuthProvider();
  return createAuth({
    authEmailPort: buildAuthEmailPort(overrides),
    secondaryStore: overrides?.secondaryStore ?? getSecondaryStore(),
  });
};

const authFactory = createCachedFactory<Auth, AuthInstanceOverrides>(buildAuth);

export const getAuth = (overrides?: AuthInstanceOverrides) =>
  authFactory.get(overrides);

export const auth = new Proxy({} as Auth, {
  get(_target, prop) {
    const instance = getAuth();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});

const buildAuthHttpGateway = (
  overrides?: AuthHttpOverrides
): AuthHttpGateway => {
  if (overrides?.authHttpGateway) return overrides.authHttpGateway;
  const authInstance = getAuth(overrides);
  const { adminEndpointsEnabled, openApiEnabled } = getBetterAuthConfig();

  return {
    handle: (request) => {
      const { pathname } = new URL(request.url, 'http://localhost');
      if (
        isBlockedBetterAuthHttpPath(pathname, {
          adminEndpointsEnabled,
          openApiEnabled,
        })
      ) {
        return new Response('Not Found', { status: 404 });
      }
      return authInstance.handler(request);
    },
  };
};

const authHttpFactory = createCachedFactory<AuthHttpGateway, AuthHttpOverrides>(
  buildAuthHttpGateway
);

export const getAuthHttpGateway = (overrides?: AuthHttpOverrides) =>
  authHttpFactory.get(overrides);

const buildAuthUseCases = (overrides?: AuthOverrides) => {
  const authEmailPort = buildAuthEmailPort(overrides);
  const authInstance = getAuth({ authEmailPort });
  const telemetry = telemetryProxy;

  return createAuthUseCases({
    sessionGateway:
      overrides?.sessionGateway ??
      new SessionGatewayBetterAuth(
        authInstance,
        undefined,
        undefined,
        telemetry
      ),
    authorizationGateway:
      overrides?.authorizationGateway ??
      new AuthorizationGatewayBetterAuth(authInstance, telemetry),
    authEmailPort,
    userAdminGateway:
      overrides?.userAdminGateway ??
      new UserAdminGatewayBetterAuth(authInstance, undefined, telemetry),
  });
};

const factory = createCachedFactory(buildAuthUseCases);

export const getAuthUseCases = (overrides?: AuthOverrides) =>
  factory.get(overrides);

/** Test-only. */
export const __resetAuthComposition = () => {
  factory.reset();
  authFactory.reset();
  authHttpFactory.reset();
  secondaryStoreFactory.reset();
};

export { createAuth };
export type { Auth };
