import { metrics } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import {
  CompositePropagator,
  ExportResultCode,
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

import { getTelemetryConfig } from '@/modules/kernel/infrastructure/config/telemetry';
import type { TelemetryLogRecord } from '@/platform/telemetry';

import { telemetrySignalUrl } from './collector-url';
import { createOpenTelemetryAdapter } from './otel-adapter';

const createResource = () => {
  const config = getTelemetryConfig();
  return resourceFromAttributes({
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.otelEnvironment,
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...(config.serviceVersion
      ? { [ATTR_SERVICE_VERSION]: config.serviceVersion }
      : {}),
  });
};

const exporterHeaders = () => {
  const { collectorBearerToken } = getTelemetryConfig();
  return collectorBearerToken
    ? { Authorization: `Bearer ${collectorBearerToken}` }
    : undefined;
};

export const initOpenTelemetryServer = () => {
  const config = getTelemetryConfig();
  if (!config.collectorUrl) {
    return undefined;
  }

  const resource = createResource();
  const headers = exporterHeaders();
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

  tracerProvider.register({
    propagator: new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
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
  metrics.setGlobalMeterProvider(meterProvider);

  const exporter = new OTLPLogExporter({
    headers,
    url: telemetrySignalUrl(config.collectorUrl, 'logs'),
    timeoutMillis: 5_000,
  });
  const batch = new BatchLogRecordProcessor(exporter);
  const delivery = new AsyncLocalStorage<(accepted: boolean) => void>();
  const processor: LogRecordProcessor = {
    onEmit(record) {
      const acknowledge = delivery.getStore();
      if (!acknowledge) {
        batch.onEmit(record);
        return;
      }
      exporter.export([record], (result) => {
        acknowledge(result.code === ExportResultCode.SUCCESS);
      });
    },
    forceFlush: () => batch.forceFlush(),
    shutdown: () => batch.shutdown(),
  };
  const loggerProvider = new LoggerProvider({
    processors: [processor],
    resource,
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  const adapter = createOpenTelemetryAdapter(
    loggerProvider.getLogger('selective-designer')
  );
  return {
    adapter,
    deliver: (record: TelemetryLogRecord) =>
      new Promise<boolean>((resolve) =>
        delivery.run(resolve, () => adapter.emitLog(record))
      ),
  };
};
