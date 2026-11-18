import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import {
  createClientOnlyFn,
  getGlobalStartContext,
} from '@tanstack/react-start';

import { createClientQueryClient } from '@/composition/client-query';
import { telemetryProxy } from '@/composition/telemetry';
import { authQueries } from '@/modules/auth/client';
import { createNoOpFlags } from '@/platform/flags';
import { readCspNonceFromMeta } from '@/platform/http/csp-nonce';
import type {
  CurrentSessionLike,
  RouterContext,
} from '@/platform/router/context';
import { attachRouterObservability } from '@/platform/router/observability';
import { frontendLogger } from '@/platform/telemetry/frontend-logger';

import { routeTree } from './routeTree.gen';

const initTelemetryClientOnly = createClientOnlyFn(async (router: unknown) => {
  const { initTelemetryClient } =
    await import('@/composition/telemetry/sentry.client');

  initTelemetryClient(router);
});

const shouldAutoInitTelemetry = import.meta.env.MODE !== 'test';

const startTelemetryInitialization = (
  initialization: Promise<unknown>,
  failureEvent: string
) => {
  initialization.catch((error: unknown) => {
    frontendLogger.warn(failureEvent, { error });
  });
};

if (!import.meta.env.SSR && shouldAutoInitTelemetry) {
  // Start client instrumentation at module evaluation so document/fetch
  // telemetry is active before router subscriptions begin handling navigation.
  startTelemetryInitialization(
    initTelemetryClientOnly(undefined),
    'telemetry.client_init_failed'
  );
}

const flags = createNoOpFlags();

type RequestContextWithCspNonce = {
  cspNonce?: unknown;
};

const getCspNonceFromStartContext = () => {
  try {
    const context = getGlobalStartContext() as RequestContextWithCspNonce;
    return typeof context.cspNonce === 'string' ? context.cspNonce : undefined;
  } catch {
    return undefined;
  }
};

const getRouterCspNonce = () =>
  getCspNonceFromStartContext() ?? readCspNonceFromMeta();

export function getRouter() {
  const queryClient = createClientQueryClient();
  const cspNonce = getRouterCspNonce();
  const currentSessionQuery = authQueries.currentSession();
  const getSessionSnapshot = (): CurrentSessionLike | null | undefined =>
    queryClient.getQueryData(currentSessionQuery.queryKey);
  const getSession = (options?: { requireFresh?: boolean }) => {
    if (!import.meta.env.SSR && !options?.requireFresh) {
      const snapshot = getSessionSnapshot();
      if (snapshot !== undefined) return Promise.resolve(snapshot);
    }

    return queryClient.fetchQuery(currentSessionQuery);
  };
  const routerContext: RouterContext = {
    queryClient,
    // Cached per router/query client so concurrent route guards within a
    // navigation share the sanitized current-session fetch without sharing
    // cache state across SSR requests or router instances.
    auth: {
      getSession,
      getSessionSnapshot,
    },
    telemetry: telemetryProxy,
    flags,
  };

  const router = createRouter({
    context: routerContext,
    defaultPreload: 'intent',
    // Since we're using React Query, we don't want loader calls to ever be stale
    // This will ensure that the loader is always called when the route is preloaded or visited
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    ssr: cspNonce ? { nonce: cspNonce } : undefined,
    routeTree,
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    wrapQueryClient: false,
  });

  if (!import.meta.env.SSR) {
    attachRouterObservability(router);
  }

  return router;
}
