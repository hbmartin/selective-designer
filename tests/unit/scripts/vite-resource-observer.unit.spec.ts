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
    plugins: [],
    environments: {
      client: { dev: { createEnvironment: async () => environment } },
    },
    getSortedPlugins: () => [],
  } as unknown as ResolvedConfig;
  const observer = createViteResourceObserver();
  observer.register(config);
  async function initialize() {
    const env = await config.environments.client!.dev.createEnvironment(
      'client',
      config,
      { ws: { close: async () => {} } } as never
    );
    await env.init({ watcher } as never);
  }
  return { watcher, config, observer, initialize };
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
it('retains a transient native failure without retrying or claiming recovery', async () => {
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
  expect(await completion).toEqual([failure]);
  expect(close).toHaveBeenCalledOnce();
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
  expect(close).toHaveBeenCalledOnce();
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
it('releases settled scopes while preserving failure values for final reporting', async () => {
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
  expect(failing.observer.release(failing.config)).toBe(true);
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
    plugins: [],
    environments: {
      client: { dev: { createEnvironment: async () => environment } },
    },
    getSortedPlugins: () => [],
  } as unknown as ResolvedConfig;
  const observer = createViteResourceObserver();
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

it('runs cleanup despite a frozen plugin and keeps independent hooks observable', async () => {
  const other = vi.fn(async () => {});
  const frozen = Object.freeze({ name: 'frozen', closeServer: async () => {} });
  const plugin = { name: 'other', closeServer: other };
  const config = {
    plugins: [frozen, plugin],
    environments: {},
  } as unknown as ResolvedConfig;
  const observer = createViteResourceObserver();
  const action = vi.fn(async () => {
    await plugin.closeServer();
  });
  await observer.run(config, action);
  expect(action).toHaveBeenCalledOnce();
  expect(other).toHaveBeenCalledOnce();
  expect(await observer.settle(config)).toEqual([expect.any(TypeError)]);
  expect(observer.release(config)).toBe(true);
  expect(await observer.settleAll()).toEqual([expect.any(TypeError)]);
});
it('does not query Vite sorted-hook caches while preparing hooks', async () => {
  const sorted = vi.fn(() => {
    throw new Error('cache accessed early');
  });
  const plugin = {
    name: 'late',
    closeServer: undefined as (() => Promise<void>) | undefined,
  };
  const config = {
    plugins: [plugin],
    getSortedPlugins: sorted,
    getSortedPluginHooks: sorted,
  } as unknown as ResolvedConfig;
  const observer = createViteResourceObserver();
  observer.prepare(config);
  const close = vi.fn(async () => {});
  plugin.closeServer = close;
  observer.prepare(config);
  await observer.run(config, () => plugin.closeServer!());
  expect(await observer.settle(config)).toEqual([]);
  expect(close).toHaveBeenCalledOnce();
  expect(sorted).not.toHaveBeenCalled();
});
it('never retries a transient failure through an installed application wrapper', async () => {
  const failure = Object.assign(new Error('Busy'), { code: 'EBUSY' });
  const f = fixture(vi.fn().mockRejectedValue(failure));
  await f.initialize();
  const previous = f.watcher.close;
  const application = vi.fn(async () => {
    await previous();
  });
  f.watcher.close = application;
  await Promise.allSettled([f.observer.run(f.config, () => f.watcher.close())]);
  expect(await f.observer.settle(f.config)).toEqual([failure]);
  expect(application).toHaveBeenCalledOnce();
});
it('attempts an uncalled native closer once after an outer wrapper fails before delegation', async () => {
  const failure = new Error('Wrapper failed before delegation');
  const native = vi.fn().mockResolvedValue(undefined);
  const f = fixture(native);
  await f.initialize();
  const outer = vi.fn(async () => {
    throw failure;
  });
  f.watcher.close = outer;
  await Promise.allSettled([f.observer.run(f.config, () => f.watcher.close())]);
  expect(await f.observer.settle(f.config)).toEqual([failure]);
  expect(native).toHaveBeenCalledOnce();
  expect(outer).toHaveBeenCalledOnce();
});
it('releases each orphan as it settles independently of stuck siblings', async () => {
  const observer = createViteResourceObserver();
  const delayed = Promise.withResolvers<void>();
  async function orphan(close: () => Promise<void>) {
    const watcher = { close };
    const environment = {
      init: async () => {},
      close: async () => {},
    } as unknown as DevEnvironment;
    const config = {
      plugins: [],
      environments: {
        client: { dev: { createEnvironment: async () => environment } },
      },
    } as unknown as ResolvedConfig;
    observer.prepare(config);
    const env = await config.environments.client!.dev.createEnvironment(
      'client',
      config,
      { ws: { close: async () => {} } } as never
    );
    await env.init({ watcher } as never);
    return config;
  }
  const clean = await orphan(async () => {});
  const pending = await orphan(() => delayed.promise);
  const batch = observer.settleOrphans();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observer.release(clean)).toBe(false);
  expect(await observer.settle(clean)).toEqual([]);
  expect(observer.release(clean)).toBe(false);
  delayed.resolve();
  expect(await batch).toEqual([]);
  expect(observer.release(pending)).toBe(false);
  expect(await observer.settleAll()).toEqual([]);
});

it('waits for an in-flight outer close before considering the native fallback', async () => {
  const gate = Promise.withResolvers<void>();
  const native = vi.fn(async () => {});
  const f = fixture(native);
  await f.initialize();
  const previous = f.watcher.close;
  f.watcher.close = async () => {
    await gate.promise;
    await previous();
  };
  const outer = f.observer.run(f.config, () => f.watcher.close());
  const settlement = f.observer.settle(f.config);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(native).not.toHaveBeenCalled();
  gate.resolve();
  await outer;
  expect(await settlement).toEqual([]);
  expect(native).toHaveBeenCalledOnce();
});
it('waits for a rejecting outer close then invokes its uncalled native closer once', async () => {
  const gate = Promise.withResolvers<void>();
  const failure = new Error('Flush failed');
  const native = vi.fn(async () => {});
  const f = fixture(native);
  await f.initialize();
  f.watcher.close = () => gate.promise;
  const outer = f.observer
    .run(f.config, () => f.watcher.close())
    .catch((error) => error);
  const settlement = f.observer.settle(f.config);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(native).not.toHaveBeenCalled();
  gate.reject(failure);
  expect(await outer).toBe(failure);
  expect(await settlement).toEqual([failure]);
  expect(native).toHaveBeenCalledOnce();
});
it('releases each final-settlement scope before a stuck sibling settles', async () => {
  const observer = createViteResourceObserver();
  const gate = Promise.withResolvers<void>();
  async function orphan(close: () => Promise<void>) {
    const watcher = { close };
    const environment = {
      init: async () => {},
      close: async () => {},
    } as unknown as DevEnvironment;
    const config = {
      plugins: [],
      environments: {
        client: { dev: { createEnvironment: async () => environment } },
      },
    } as unknown as ResolvedConfig;
    observer.prepare(config);
    const env = await config.environments.client!.dev.createEnvironment(
      'client',
      config,
      { ws: { close: async () => {} } } as never
    );
    await env.init({ watcher } as never);
    return config;
  }
  const clean = await orphan(async () => {});
  const pending = await orphan(() => gate.promise);
  const batch = observer.settleAll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observer.release(clean)).toBe(false);
  expect(await observer.settle(clean)).toEqual([]);
  gate.resolve();
  expect(await batch).toEqual([]);
  expect(observer.release(pending)).toBe(false);
});
