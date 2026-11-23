import { afterEach, expect, it, vi } from 'vitest';
import type { DevEnvironment, ResolvedConfig } from 'vite';
import { createViteResourceObserver } from '@tests/server/vite-resource-observer';

function fixture(close: () => Promise<void>) {
  const watcher = { close };
  const environment = {
    init: async () => {},
    close: async () => {},
  } as unknown as DevEnvironment;
  const config = {
    environments: {
      client: { dev: { createEnvironment: async () => environment } },
    },
    getSortedPlugins: () => [],
  } as unknown as ResolvedConfig;
  const recovered = vi.fn();
  const observer = createViteResourceObserver(recovered);
  observer.register(config);
  async function initialize() {
    const env = await config.environments.client!.dev.createEnvironment(
      'client',
      config,
      { ws: { close: async () => {} } } as never
    );
    await env.init({ watcher } as never);
  }
  return { watcher, config, observer, recovered, initialize };
}
afterEach(() => vi.useRealTimers());
it('retains a native watcher rejection even when Vite discards it', async () => {
  const failure = new Error('Native watcher failed');
  const f = fixture(vi.fn().mockRejectedValue(failure));
  await f.initialize();
  await Promise.allSettled([f.observer.run(f.config, () => f.watcher.close())]);
  expect(await f.observer.settle(f.config)).toEqual([failure]);
  expect(await f.observer.settleAll()).toEqual([failure]);
});
it('retries a completed transient native failure once and records successful recovery', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const failure = Object.assign(new Error('Busy watcher'), { code: 'EBUSY' });
  const close = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(undefined);
  const f = fixture(close);
  await f.initialize();
  await Promise.allSettled([f.observer.run(f.config, () => f.watcher.close())]);
  const completion = f.observer.settle(f.config);
  await vi.advanceTimersByTimeAsync(50);
  expect(await completion).toEqual([]);
  expect(close).toHaveBeenCalledTimes(2);
  expect(f.recovered).toHaveBeenCalledExactlyOnceWith(failure);
});
it('does not classify a cached rejected native promise as recovered', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const failure = Object.assign(new Error('Cached failure'), {
    code: 'EAGAIN',
  });
  const rejected = Promise.reject(failure);
  const close = vi.fn(() => rejected);
  const f = fixture(close);
  await f.initialize();
  await Promise.allSettled([f.observer.run(f.config, () => f.watcher.close())]);
  const completion = f.observer.settle(f.config);
  await vi.advanceTimersByTimeAsync(50);
  expect(await completion).toEqual([failure]);
  expect(close).toHaveBeenCalledTimes(2);
  expect(f.recovered).not.toHaveBeenCalled();
});
it('observes later plugin wrappers without recursive delegation', async () => {
  const failure = new Error('Outer plugin close failed');
  const native = vi.fn().mockResolvedValue(undefined);
  const f = fixture(native);
  await f.initialize();
  const previous = f.watcher.close;
  f.watcher.close = async () => {
    await Promise.resolve();
    await previous();
    throw failure;
  };
  await Promise.allSettled([f.observer.run(f.config, () => f.watcher.close())]);
  expect(await f.observer.settle(f.config)).toEqual([failure]);
  expect(native).toHaveBeenCalledOnce();
});

it('bounds native restart retirement without cancelling its pending cleanup', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(() => pending);
  await f.initialize();
  const native = Promise.resolve().then(() =>
    f.observer.run(f.config, () => f.watcher.close())
  );
  const restart = f.observer.boundRestart(f.config, native);
  await Promise.all([
    expect(restart).rejects.toThrow('retirement exceeded five seconds'),
    vi.advanceTimersByTimeAsync(5000),
  ]);
  let drained = false;
  const finishing = f.observer.settle(f.config).then((errors) => {
    drained = true;
    return errors;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  expect(await finishing).toEqual([]);
});
it('does not retry outside the original retirement deadline', async () => {
  const failure = Object.assign(new Error('Busy'), { code: 'EBUSY' });
  const close = vi.fn().mockRejectedValue(failure);
  const f = fixture(close);
  await f.initialize();
  await Promise.allSettled([f.observer.run(f.config, () => f.watcher.close())]);
  expect(await f.observer.settle(f.config, performance.now())).toEqual([
    failure,
  ]);
  expect(close).toHaveBeenCalledOnce();
});
it('releases only scopes that settled without failures', async () => {
  const clean = fixture(vi.fn().mockResolvedValue(undefined));
  await clean.initialize();
  await clean.observer.run(clean.config, () => clean.watcher.close());
  expect(clean.observer.release(clean.config)).toBe(false);
  expect(await clean.observer.settle(clean.config)).toEqual([]);
  expect(clean.observer.release(clean.config)).toBe(true);

  const failure = new Error('Retained native failure');
  const failing = fixture(vi.fn().mockRejectedValue(failure));
  await failing.initialize();
  await Promise.allSettled([
    failing.observer.run(failing.config, () => failing.watcher.close()),
  ]);
  expect(await failing.observer.settle(failing.config)).toEqual([failure]);
  expect(failing.observer.release(failing.config)).toBe(false);
  expect(await failing.observer.settleAll()).toEqual([failure]);
});
it('settles each orphan scope once while final settlement still reports it', async () => {
  const failure = new Error('Orphan watcher failed');
  const nativeClose = vi.fn().mockRejectedValue(failure);
  const watcher = { close: nativeClose };
  const environment = {
    init: async () => {},
    close: async () => {},
  } as unknown as DevEnvironment;
  const config = {
    environments: {
      client: { dev: { createEnvironment: async () => environment } },
    },
    getSortedPlugins: () => [],
  } as unknown as ResolvedConfig;
  const observer = createViteResourceObserver(vi.fn());
  observer.prepare(config);
  const env = await config.environments.client!.dev.createEnvironment(
    'client',
    config,
    { ws: { close: async () => {} } } as never
  );
  await env.init({ watcher } as never);
  expect(await observer.settleOrphans(performance.now() + 5_000)).toEqual([
    failure,
  ]);
  expect(await observer.settleOrphans(performance.now() + 5_000)).toEqual([]);
  expect(nativeClose).toHaveBeenCalledOnce();
  expect(await observer.settleAll()).toEqual([failure]);
});
