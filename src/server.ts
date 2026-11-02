import { wrapFetchWithSentry } from '@sentry/tanstackstart-react';
import handler, {
  createServerEntry,
  type ServerEntry,
} from '@tanstack/react-start/server-entry';
import { randomUUID } from 'node:crypto';
import '../instrument.server.mjs';

import { validateServerConfig } from '@/modules/kernel/backend';

import type { AppStartRequestContext } from './start';

type ServerEntryRequestContext = AppStartRequestContext & { nonce?: string };

// Fail-closed configuration validation at server boot, before request handling.
validateServerConfig();

const requestHandler: ServerEntry = wrapFetchWithSentry({
  fetch(request) {
    const context: ServerEntryRequestContext = {
      requestId: randomUUID(),
    };

    return handler.fetch(request, {
      context,
    });
  },
});

export default createServerEntry(requestHandler);
