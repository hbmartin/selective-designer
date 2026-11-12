import { context } from '@opentelemetry/api';
import * as Sentry from '@sentry/tanstackstart-react';
import { randomUUID } from 'node:crypto';

import { ConfigurationError } from '@/modules/kernel/domain/errors/configuration-error';
import { isTestRuntimeEnvironment } from '@/modules/kernel/infrastructure/config/env-schema';
import { getLoggerConfig } from '@/modules/kernel/infrastructure/config/logger';
import {
  getOtelTelemetryConfig,
  getSentryTelemetryConfig,
} from '@/modules/kernel/infrastructure/config/telemetry';
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
const bootFailureEvent = 'server.config_validation_failed';

function initSentry(dsn: string, environment: string | undefined): ServerSink {
  const url = new URL(dsn);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !/^(?:[\w.-]+|\[[\w:.%]+\])$/u.test(url.hostname) ||
    !/^\w+$/.test(url.username) ||
    (url.password && !/^\w+$/.test(url.password)) ||
    !/\/\d+$/.test(url.pathname)
  )
    throw new Error('Invalid Sentry destination');

  const pending = new Map<string, (accepted: boolean) => void>();
  const client = Sentry.init({
    dsn: url.href,
    environment,
    tracesSampleRate: 0,
    skipOpenTelemetrySetup: true,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.message === bootFailureEvent) {
        event.request = undefined;
        event.user = undefined;
        event.breadcrumbs = undefined;
      }
      return sanitizeSentryEvent(event);
    },
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
  if (!client?.getTransport()) throw new Error('Sentry transport unavailable');

  const deliver: Deliver = (record, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
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
}

const tryInitialize = <T extends ServerSink>(
  sink: 'otel' | 'sentry',
  init: () => T | undefined
) => {
  try {
    return { value: init(), failed: false };
  } catch {
    writeConsoleLogRecord({
      event: 'telemetry.server_init_failed',
      level: 'error',
      details: { sink },
    });
    return { value: undefined, failed: true };
  }
};

const unavailable: Deliver = async () => false;

function createServerTelemetry() {
  const testMode = isTestRuntimeEnvironment();
  let contextManagerInstalled = false;
  const sentryState = tryInitialize('sentry', () => {
    if (testMode) return;
    const { dsn, environment } = getSentryTelemetryConfig();
    if (!dsn) return;
    contextManagerInstalled = context.setGlobalContextManager(
      new Sentry.SentryContextManager().enable()
    );
    if (!contextManagerInstalled)
      throw new Error('Sentry request isolation unavailable');
    return initSentry(dsn, environment);
  });
  const otelState = tryInitialize('otel', () => {
    if (testMode) return;
    const config = getOtelTelemetryConfig();
    if (!config.collectorUrl) return;
    return initOpenTelemetryServer(
      { ...config, collectorUrl: config.collectorUrl },
      contextManagerInstalled ? null : undefined
    );
  });
  const { value: otel } = otelState;
  const { value: sentry } = sentryState;
  const adapters = [otel?.adapter, sentry?.adapter].filter(
    (adapter): adapter is TelemetryAdapter => adapter !== undefined
  );
  const chain = adapters.length
    ? createTelemetryAdapterChain(adapters)
    : createNoOpTelemetry();
  const adapter: TelemetryAdapter = {
    ...chain,
    emitLog: (record) => {
      if (otel) otel.adapter.emitLog(record);
      // Sentry accepts exception and terminal issue events, not ordinary logs.
      else if (!getLoggerConfig().consoleMirror) writeConsoleLogRecord(record);
    },
  };
  const destinations = [
    ...(otel || otelState.failed ? [otel?.deliver ?? unavailable] : []),
    ...(sentry || sentryState.failed ? [sentry?.deliver ?? unavailable] : []),
  ];
  return {
    adapter,
    destinations,
    sentry,
    withOtelUserScope: otel?.withUserScope,
  };
}

const runtimeKey = Symbol.for('selective-designer.server-telemetry');
type ServerTelemetry = ReturnType<typeof createServerTelemetry>;

export function getServerTelemetry() {
  const host = globalThis as typeof globalThis & {
    [runtimeKey]?: ServerTelemetry;
  };
  return (host[runtimeKey] ??= createServerTelemetry());
}

let proxyInstalled = false;

/** Install the shared providers in this bundle's proxy. */
export function initTelemetryServer() {
  if (proxyInstalled) return;
  setTelemetry(getServerTelemetry().adapter);
  proxyInstalled = true;
}

export function withServerTelemetryScope<T>(run: () => T): T {
  const { sentry, withOtelUserScope } = getServerTelemetry();
  const runRequest = () => (withOtelUserScope ? withOtelUserScope(run) : run());
  return sentry ? Sentry.withIsolationScope(runRequest) : runRequest();
}

export async function reportBootConfigurationFailure(error: unknown) {
  const issues =
    error instanceof ConfigurationError ? error.details?.issues : undefined;
  const fields = Array.isArray(issues)
    ? issues.flatMap((issue: { field?: unknown }) =>
        typeof issue?.field === 'string' &&
        /^[A-Z][A-Z0-9_]*$/.test(issue.field)
          ? [issue.field]
          : []
      )
    : [];
  const record: TelemetryLogRecord = {
    level: 'error',
    event: bootFailureEvent,
    details: { code: 'CONFIGURATION_ERROR', fields: [...new Set(fields)] },
  };
  const { sentry } = getServerTelemetry();
  if (!(await sentry?.deliver(record, AbortSignal.timeout(5_000)))) {
    writeConsoleLogRecord(record);
  }
}
