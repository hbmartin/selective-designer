import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UpstashSecondaryStore } from '@/modules/auth/infrastructure/secondary-store/upstash-secondary-store';
import type { ApplicationResult } from '@/modules/kernel/testing';
import type { TelemetryAdapter } from '@/platform/telemetry';

const captureException = vi.fn();
const telemetry = { captureException } as unknown as Pick<
  TelemetryAdapter,
  'captureException'
>;

const config = {
  restUrl: 'https://redis.example.com',
  restToken: 'token-123',
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const expectOk = async <TOutcome extends { type: string }>(
  value: Promise<ApplicationResult<TOutcome>>,
  expected: TOutcome
) => {
  const result = await value;
  if (result.isError()) throw result.getError();
  expect(result.get()).toEqual(expected);
};

const expectErrorCode = async <TOutcome extends { type: string }>(
  value: Promise<ApplicationResult<TOutcome>>,
  code: string
) => {
  const result = await value;
  if (result.isOk()) {
    throw new Error(`Expected ${code} error, received ${result.get().type}.`);
  }
  expect(result.getError()).toMatchObject({ code });
};

describe('UpstashSecondaryStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('issues a GET command and returns the stored value', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: 'value-1' }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectOk(store.get('key-1'), {
      type: 'secondary_store_hit',
      value: 'value-1',
    });
    expect(fetchFn).toHaveBeenCalledWith(
      config.restUrl,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${config.restToken}`,
        }),
        body: JSON.stringify(['GET', 'key-1']),
      })
    );
  });

  it('treats a null result as a miss', async () => {
    expect.hasAssertions();

    const fetchFn = vi.fn(async () => jsonResponse({ result: null }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectOk(store.get('absent'), { type: 'secondary_store_miss' });
  });

  it('sends SET with an EX ttl and DEL commands', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: 'OK' }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectOk(store.set('key-1', 'value-1', 60), {
      type: 'secondary_store_set',
    });
    expect(fetchFn).toHaveBeenLastCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: JSON.stringify(['SET', 'key-1', 'value-1', 'EX', 60]),
      })
    );

    await expectOk(store.set('key-2', 'value-2'), {
      type: 'secondary_store_set',
    });
    expect(fetchFn).toHaveBeenLastCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: JSON.stringify(['SET', 'key-2', 'value-2']),
      })
    );

    await expectOk(store.delete('key-1'), {
      type: 'secondary_store_deleted',
    });
    expect(fetchFn).toHaveBeenLastCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: JSON.stringify(['DEL', 'key-1']),
      })
    );
  });

  it('takes a matching value with one EVAL command', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: 'value-1' }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectOk(store.take('key-1', 'value-1'), {
      type: 'secondary_store_taken',
      value: 'value-1',
    });

    expect(fetchFn).toHaveBeenCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: expect.stringContaining('"EVAL"'),
      })
    );
    expect(fetchFn).toHaveBeenCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: expect.stringContaining('"key-1"'),
      })
    );
    expect(fetchFn).toHaveBeenCalledWith(
      config.restUrl,
      expect.objectContaining({
        body: expect.stringContaining('"value-1"'),
      })
    );
  });

  it('treats a non-matching take as a miss', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: null }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    const result = await store.take('key-1', 'value-1');

    expect(result).toMatchObject({
      tag: 'Ok',
      value: { type: 'secondary_store_miss' },
    });
  });

  it('returns and reports read failures on transport errors', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    });
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectErrorCode(
      store.get('key-1'),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('returns and reports write failures', async () => {
    const fetchFn = vi.fn(async () => new Response('boom', { status: 500 }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectErrorCode(
      store.set('key-1', 'value-1'),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    await expectErrorCode(
      store.delete('key-1'),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('aborts slow Upstash requests', async () => {
    const fetchFn = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    );
    const store = new UpstashSecondaryStore({
      config,
      fetchFn,
      timeoutMs: 1,
      telemetry,
    });

    await expectErrorCode(
      store.get('key-1'),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid ttl values before issuing a request', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: 'OK' }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });

    await expectErrorCode(
      store.set('key-1', 'value-1', Number.NaN),
      'AUTH_SECONDARY_STORE_INVALID_TTL'
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses GETDEL for get-and-delete', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: 'value-1' }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });
    await expectOk(store.getAndDelete('key-1'), {
      type: 'secondary_store_taken',
      value: 'value-1',
    });
    expect(fetchFn).toHaveBeenCalledWith(
      config.restUrl,
      expect.objectContaining({ body: JSON.stringify(['GETDEL', 'key-1']) })
    );
  });

  it('increments atomically and sets the TTL only on creation', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ result: 3 }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });
    await expectOk(store.increment('rate-1', 60), {
      type: 'secondary_store_incremented',
      value: 3,
    });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as unknown[];
    expect(body[0]).toBe('EVAL');
    expect(String(body[1])).toContain('INCR');
    expect(String(body[1])).toContain('if value == 1 then');
    expect(body.slice(2)).toEqual([1, 'rate-1', 60]);
  });

  it('reports failed increments', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 503 }));
    const store = new UpstashSecondaryStore({ config, fetchFn, telemetry });
    await expectErrorCode(
      store.increment('rate-1', 60),
      'AUTH_SECONDARY_STORE_UPSTASH_ERROR'
    );
    expect(captureException).toHaveBeenCalledOnce();
  });
});
