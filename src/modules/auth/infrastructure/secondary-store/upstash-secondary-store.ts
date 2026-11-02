import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { ConfigurationError } from '@/modules/kernel/domain/errors/configuration-error';
import {
  getRedisConfig,
  type RedisConfig,
} from '@/modules/kernel/infrastructure/config/redis';
import type { TelemetryAdapter } from '@/platform/telemetry';

import type { SecondaryStore } from '../../application/ports/secondary-store';

const upstashError = (message: string, cause?: unknown) =>
  new AppError({
    code: 'AUTH_SECONDARY_STORE_UPSTASH_ERROR',
    category: 'system',
    status: 502,
    message,
    cause,
  });

/**
 * Durable {@link SecondaryStore} backed by Upstash Redis over its REST API.
 *
 * Commands are issued in array form (`POST <restUrl>` with a
 * `["SET", key, value, "EX", ttl]` / `["GET", key]` / `["DEL", key]` body and
 * `Authorization: Bearer <restToken>`), and the `{ result }` envelope is parsed
 * back out. A Redis/network outage must not hard-fail authentication, so
 * transport failures are returned as Result errors and reported to telemetry.
 * The Better Auth adapter decides how to degrade those failures for the
 * framework's nullable/void secondary-storage contract.
 */

type UpstashCommand = (string | number)[];
type CommandOutcome = BoxedResult<unknown, AppError>;

const DEFAULT_TIMEOUT_MS = 2_000;
const TAKE_IF_MATCHES_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if value == ARGV[1] then
  redis.call("DEL", KEYS[1])
  return value
end
return nil
`;

export type UpstashSecondaryStoreOptions = {
  /** Injected telemetry sink used to report best-effort transport failures. */
  telemetry: Pick<TelemetryAdapter, 'captureException'>;
  config?: RedisConfig;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

export class UpstashSecondaryStore implements SecondaryStore {
  private readonly restUrl: string;
  private readonly restToken: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly telemetry: Pick<TelemetryAdapter, 'captureException'>;

  constructor(options: UpstashSecondaryStoreOptions) {
    const config = options.config ?? getRedisConfig();
    if (!config) {
      throw new ConfigurationError(
        'UpstashSecondaryStore requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.'
      );
    }
    this.restUrl = config.restUrl;
    this.restToken = config.restToken;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.telemetry = options.telemetry;
  }

  private reportFailure(operation: string, error: unknown): void {
    this.telemetry.captureException(error, {
      level: 'warning',
      tags: { 'auth.secondary_store': 'upstash', 'auth.operation': operation },
    });
  }

  private invalidTtlError(ttlSeconds: number) {
    return new AppError({
      code: 'AUTH_SECONDARY_STORE_INVALID_TTL',
      category: 'system',
      status: 500,
      message: 'Secondary store ttlSeconds must be a finite positive number.',
      details: { ttlSeconds },
    });
  }

  private async command(args: UpstashCommand): Promise<CommandOutcome> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(this.restUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.restToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      if (!response.ok) {
        return Result.Error(
          upstashError(`Upstash request failed with status ${response.status}`)
        );
      }
      const body = (await response.json()) as {
        result?: unknown;
        error?: string;
      };
      if (typeof body.error === 'string') {
        return Result.Error(upstashError(body.error));
      }
      return Result.Ok(body.result ?? null);
    } catch (error) {
      return Result.Error(upstashError('Upstash request failed', error));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async get(key: string): ReturnType<SecondaryStore['get']> {
    const outcome = await this.command(['GET', key]);
    if (outcome.isError()) {
      this.reportFailure('get', outcome.getError());
      return Result.Error(outcome.getError());
    }
    const value = outcome.get();
    return typeof value === 'string'
      ? Result.Ok({ type: 'secondary_store_hit', value })
      : Result.Ok({ type: 'secondary_store_miss' });
  }

  async set(
    key: string,
    value: string,
    ttlSeconds?: number
  ): ReturnType<SecondaryStore['set']> {
    if (
      ttlSeconds !== undefined &&
      (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)
    ) {
      return Result.Error(this.invalidTtlError(ttlSeconds));
    }

    const args: UpstashCommand =
      ttlSeconds !== undefined
        ? ['SET', key, value, 'EX', ttlSeconds]
        : ['SET', key, value];
    const outcome = await this.command(args);
    if (outcome.isError()) {
      this.reportFailure('set', outcome.getError());
      return Result.Error(outcome.getError());
    }
    return Result.Ok({ type: 'secondary_store_set' });
  }

  async take(
    key: string,
    expectedValue: string
  ): ReturnType<SecondaryStore['take']> {
    const outcome = await this.command([
      'EVAL',
      TAKE_IF_MATCHES_SCRIPT,
      1,
      key,
      expectedValue,
    ]);
    if (outcome.isError()) {
      this.reportFailure('take', outcome.getError());
      return Result.Error(outcome.getError());
    }
    const value = outcome.get();
    return typeof value === 'string'
      ? Result.Ok({ type: 'secondary_store_taken', value })
      : Result.Ok({ type: 'secondary_store_miss' });
  }

  async delete(key: string): ReturnType<SecondaryStore['delete']> {
    const outcome = await this.command(['DEL', key]);
    if (outcome.isError()) {
      this.reportFailure('delete', outcome.getError());
      return Result.Error(outcome.getError());
    }
    return Result.Ok({ type: 'secondary_store_deleted' });
  }
}
