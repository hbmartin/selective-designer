import { convertLegacyHttpOptions } from '@opentelemetry/otlp-exporter-base/node-http';
import { ProtobufLogsSerializer } from '@opentelemetry/otlp-transformer';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { type IncomingMessage, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const MAX_IN_FLIGHT = 30;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const compress = promisify(gzip);

export function createTerminalOtlpExporter(
  url: string,
  headers?: Record<string, string>
) {
  const config = convertLegacyHttpOptions({ url, headers }, 'LOGS', 'v1/logs', {
    'Content-Type': 'application/x-protobuf',
  });
  const endpoint = new URL(config.url);
  const request = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
  let agent: ReturnType<typeof config.agentFactory> | undefined;
  let inFlight = 0;

  return async (record: ReadableLogRecord, signal: AbortSignal) => {
    if (signal.aborted || inFlight >= MAX_IN_FLIGHT) return false;
    inFlight++;
    try {
      const serialized = ProtobufLogsSerializer.serializeRequest([record]);
      if (!serialized) return false;
      const compressed = config.compression === 'gzip';
      const [body, exportHeaders, exportAgent] = await Promise.all([
        compressed ? compress(serialized) : serialized,
        config.headers(),
        (agent ??= config.agentFactory(endpoint.protocol)),
      ]);
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const outgoing = request(
          endpoint,
          {
            method: 'POST',
            headers: {
              ...exportHeaders,
              ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
              ...(config.userAgent ? { 'User-Agent': config.userAgent } : {}),
            },
            agent: exportAgent,
            signal,
          },
          resolve
        );
        outgoing.once('error', reject);
        outgoing.end(body);
      });
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.destroy();
        return false;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response) {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) return false;
        chunks.push(chunk);
      }
      const result = bytes
        ? ProtobufLogsSerializer.deserializeResponse(
            Buffer.concat(chunks, bytes)
          )
        : undefined;
      return (result?.partialSuccess?.rejectedLogRecords ?? 0) === 0;
    } catch {
      return false;
    } finally {
      inFlight--;
    }
  };
}
