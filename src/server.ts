import { wrapFetchWithSentry } from '@sentry/tanstackstart-react';
import handler, {
  createServerEntry,
  type ServerEntry,
} from '@tanstack/react-start/server-entry';
import { randomUUID } from 'node:crypto';

import { withRequestLifetime } from '@/composition/telemetry/request-lifetime';
import {
  initTelemetryServer,
  reportBootConfigurationFailure,
  withServerTelemetryScope,
} from '@/composition/telemetry/sentry.server';
import { validateServerConfig } from '@/modules/kernel/backend';
import { replaceCspNoncePlaceholderInHtmlResponse } from '@/platform/http/csp-nonce';
import { createCspNonce } from '@/platform/http/csp-nonce-server';

import type { AppStartRequestContext } from './start';

type ServerEntryRequestContext = AppStartRequestContext & { nonce?: string };

// Fail-closed configuration validation at server boot, before request handling.
initTelemetryServer();
try {
  validateServerConfig();
} catch (error) {
  await reportBootConfigurationFailure(error).catch(() => undefined);
  throw error;
}

const requestHandler: ServerEntry = wrapFetchWithSentry({
  async fetch(request) {
    const cspNonce = createCspNonce();
    const context: ServerEntryRequestContext = {
      requestId: randomUUID(),
      cspNonce,
    };

    const response = await handler.fetch(request, {
      context,
    });
    // Rewrite the nonce placeholder only after Start returned the response, so
    // the SSR stream keeps owning its own cleanup (see securityHeadersMiddleware).
    return replaceCspNoncePlaceholderInHtmlResponse(response, cspNonce);
  },
});

const startEntry = createServerEntry(requestHandler);

export default {
  fetch: (request, options) =>
    withServerTelemetryScope(() =>
      withRequestLifetime(request, () => startEntry.fetch(request, options))
    ),
} satisfies ServerEntry;
