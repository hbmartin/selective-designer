import * as Sentry from '@sentry/tanstackstart-react';
import { randomUUID } from 'node:crypto';

import { getLoggerConfig } from '@/modules/kernel/infrastructure/config/logger';
import { getTelemetryConfig } from '@/modules/kernel/infrastructure/config/telemetry';
import { writeConsoleLogRecord } from '@/modules/kernel/infrastructure/logger/telemetry';
import {
  createNoOpTelemetry,
  type TelemetryAdapter,
  type TelemetryLogRecord,
} from '@/platform/telemetry';

import { createTelemetryAdapterChain } from './adapter-chain';
import { setTelemetry } from './index';
import { initOpenTelemetryServer } from './otel.server';
import {
  createSentryTelemetryAdapter,
  sanitizeSentryEvent,
} from './sentry-adapter';

type Deliver = (
  record: TelemetryLogRecord,
  signal: AbortSignal
) => Promise<boolean>;
type ServerSink = { adapter: TelemetryAdapter; deliver: Deliver };

const initSentry = (config: ReturnType<typeof getTelemetryConfig>) => {
  const pending = new Map<string, (accepted: boolean) => void>();
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    tracesSampleRate: 0,
    skipOpenTelemetrySetup: true,
    sendDefaultPii: false,
    beforeSend: sanitizeSentryEvent,
    transport(options: Parameters<typeof Sentry.makeNodeTransport>[0]) {
      const transport = Sentry.makeNodeTransport(options);
      return {
        flush: (timeout?: number) => transport.flush(timeout),
        send(envelope: Parameters<typeof transport.send>[0]) {
          const id = envelope[0].event_id;
          const complete = typeof id === 'string' ? pending.get(id) : undefined;
          const sent = transport.send(envelope);
          if (complete) {
            void sent.then(
              ({ statusCode }) =>
                complete(
                  statusCode !== undefined &&
                    statusCode >= 200 &&
                    statusCode < 300
                ),
              () => complete(false)
            );
          }
          return sent;
        },
      };
    },
  });

  const deliver: Deliver = (record, signal) =>
    new Promise((resolve) => {
      const eventId = randomUUID().replaceAll('-', '');
      const complete = (accepted: boolean) => {
        pending.delete(eventId);
        signal.removeEventListener('abort', onAbort);
        resolve(accepted);
      };
      const onAbort = () => complete(false);
      pending.set(eventId, complete);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        Sentry.captureEvent({
          event_id: eventId,
          message: record.event,
          level: 'error',
          fingerprint: ['terminal-diagnostic', record.event],
          tags: { event: record.event },
          extra: { details: record.details, attributes: record.attributes },
        });
      } catch {
        complete(false);
      }
    });

  return { adapter: createSentryTelemetryAdapter(Sentry), deliver };
};

const tryInitialize = (init: () => ServerSink | undefined) => {
  try {
    return init();
  } catch {
    // A failed sink must not prevent the other sink or console from working.
    return undefined;
  }
};

const unavailable: Deliver = async () => false;

function createServerTelemetry() {
  const config = getTelemetryConfig();
  const otel = config.collectorUrl
    ? tryInitialize(initOpenTelemetryServer)
    : undefined;
  const sentry = config.dsn
    ? tryInitialize(() => initSentry(config))
    : undefined;
  const adapters = [otel?.adapter, sentry?.adapter].filter(
    (adapter): adapter is TelemetryAdapter => adapter !== undefined
  );
  const chain = adapters.length
    ? createTelemetryAdapterChain(adapters)
    : createNoOpTelemetry();
  const { consoleMirror } = getLoggerConfig();
  const adapter: TelemetryAdapter = {
    ...chain,
    emitLog: (record) => {
      if (otel) otel.adapter.emitLog(record);
      // Sentry accepts exception and terminal issue events, not ordinary logs.
      else if (!consoleMirror) writeConsoleLogRecord(record);
    },
  };
  const destinations = [
    ...(config.collectorUrl ? [otel?.deliver ?? unavailable] : []),
    ...(config.dsn ? [sentry?.deliver ?? unavailable] : []),
  ];
  return { adapter, destinations };
}

const runtimeKey = Symbol.for('selective-designer.server-telemetry');
type ServerTelemetry = ReturnType<typeof createServerTelemetry>;

/** Install the same providers in the Nitro and SSR copies of the proxy. */
export function initTelemetryServer() {
  const host = globalThis as typeof globalThis & {
    [runtimeKey]?: ServerTelemetry;
  };
  const runtime = (host[runtimeKey] ??= createServerTelemetry());
  setTelemetry(runtime.adapter);
  return runtime;
}
