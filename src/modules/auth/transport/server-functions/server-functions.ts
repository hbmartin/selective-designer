import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';

import type { TelemetryAdapter } from '@/platform/telemetry';

import {
  type AuthHandlers,
  createAuthHandlers,
} from '../tanstack/auth-handlers';
import type { ServerContextTools } from '../tanstack/server-context';

type CurrentSessionDeps = {
  handlers: AuthHandlers;
  serverContextTools: ServerContextTools;
  telemetry: Pick<TelemetryAdapter, 'startSpan'>;
};

const getCurrentSessionDeps = createServerOnlyFn(
  async (): Promise<CurrentSessionDeps> => {
    const [{ getAuthUseCases }, { getKernel }, { createServerContextTools }] =
      await Promise.all([
        import('@/composition/auth'),
        import('@/composition/kernel'),
        import('../tanstack/server-context'),
      ]);

    const telemetry = getKernel().telemetry;

    return {
      handlers: createAuthHandlers(),
      serverContextTools: createServerContextTools({
        getAuthUseCases,
        telemetry,
      }),
      telemetry,
    };
  }
);

export const currentSession = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { handlers, serverContextTools, telemetry } =
      await getCurrentSessionDeps();

    return serverContextTools.withPublicContext(async (ctx) =>
      telemetry.startSpan(
        {
          attributes: {
            'operation.name': 'auth.currentSession',
            'operation.type': 'server_function',
          },
          name: 'auth.currentSession',
          op: 'server.function',
        },
        () => handlers.currentSession(ctx)
      )
    );
  }
);

export const authServerFunctions = {
  currentSession,
};

export type AuthServerFunctions = typeof authServerFunctions;
