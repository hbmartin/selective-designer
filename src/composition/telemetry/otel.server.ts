import { type ContextManager, metrics } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordProcessor,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { AsyncLocalStorage } from 'node:async_hooks';

import type { getOtelTelemetryConfig } from '@/modules/kernel/infrastructure/config/telemetry';
import type { TelemetryLogRecord, TelemetryUser } from '@/platform/telemetry';

import { telemetrySignalUrl } from './collector-url';
import { createOpenTelemetryAdapter } from './otel-adapter';
import { createTerminalOtlpExporter } from './terminal-otlp-export';

type OtelConfig = ReturnType<typeof getOtelTelemetryConfig>;

const createResource = (config: OtelConfig) =>
  resourceFromAttributes({
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.otelEnvironment,
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...(config.serviceVersion
      ? { [ATTR_SERVICE_VERSION]: config.serviceVersion }
      : {}),
  });

export const initOpenTelemetryServer = (
  config: OtelConfig & { collectorUrl: string },
  contextManager?: ContextManager | null
) => {
  const resource = createResource(config);
  const headers = config.collectorBearerToken
    ? { Authorization: `Bearer ${config.collectorBearerToken}` }
    : undefined;
  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.otelTracesSampleRate),
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          headers,
          url: telemetrySignalUrl(config.collectorUrl, 'traces'),
        })
      ),
    ],
  });

  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          headers,
          url: telemetrySignalUrl(config.collectorUrl, 'metrics'),
        }),
        exportIntervalMillis: 30_000,
      }),
    ],
    resource,
  });
  const logsUrl = telemetrySignalUrl(config.collectorUrl, 'logs');
  const batch = new BatchLogRecordProcessor(
    new OTLPLogExporter({ headers, url: logsUrl })
  );
  const exportTerminal = createTerminalOtlpExporter(logsUrl, headers);
  const terminalRecord = new AsyncLocalStorage<
    (record: ReadableLogRecord) => void
  >();
  const processor: LogRecordProcessor = {
    onEmit(record) {
      const capture = terminalRecord.getStore();
      if (capture) capture(record);
      else batch.onEmit(record);
    },
    forceFlush: () => batch.forceFlush(),
    shutdown: () => batch.shutdown(),
  };
  const loggerProvider = new LoggerProvider({
    processors: [processor],
    resource,
  });
  tracerProvider.register({
    contextManager,
    propagator: new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  });
  metrics.setGlobalMeterProvider(meterProvider);
  logs.setGlobalLoggerProvider(loggerProvider);

  const requestUser = new AsyncLocalStorage<{ value: TelemetryUser | null }>();
  const adapter = createOpenTelemetryAdapter(
    loggerProvider.getLogger('selective-designer'),
    {
      get: () => requestUser.getStore()?.value ?? null,
      set: (value) => {
        const user = requestUser.getStore();
        if (user) user.value = value;
      },
    }
  );
  return {
    adapter,
    withUserScope: <T>(run: () => T) => requestUser.run({ value: null }, run),
    async deliver(record: TelemetryLogRecord, signal: AbortSignal) {
      if (signal.aborted) return false;
      let sdkRecord: ReadableLogRecord | undefined;
      terminalRecord.run(
        (entry) => {
          sdkRecord = entry;
        },
        () => adapter.emitLog(record)
      );
      return sdkRecord ? exportTerminal(sdkRecord, signal) : false;
    },
  };
};
