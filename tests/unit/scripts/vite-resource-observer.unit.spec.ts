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

it('observes a live scope without initiating disposal or carrying a deadline to its next restart', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const watcher = { close: vi.fn(async () => {}) };
  const closeEnvironment = vi.fn(async () => {});
  const closeWebsocket = vi.fn(async () => {});
  const environment = { init: async () => {}, close: closeEnvironment };
  const websocket = { close: closeWebsocket };
  const config = {
    plugins: [],
    environments: {
      client: { dev: { createEnvironment: async () => environment } },
    },
  } as unknown as ResolvedConfig;
  const observer = createViteResourceObserver();
  observer.register(config);
  const env = await config.environments.client!.dev.createEnvironment(
    'client',
    config,
    { ws: websocket } as never
  );
  await env.init({ watcher } as never);
  await watcher.close();
  await observer.boundRestart(config, Promise.resolve());
  expect(await observer.settleStarted(config)).toEqual([]);
  expect(closeEnvironment).not.toHaveBeenCalled();
  expect(closeWebsocket).not.toHaveBeenCalled();
  expect(observer.release(config)).toBe(false);
  await vi.advanceTimersByTimeAsync(6000);
  const native = Promise.withResolvers<void>();
  const restarting = observer.boundRestart(config, native.promise);
  let completed = false;
  void restarting.then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(6000);
  expect(completed).toBe(false);
  native.resolve();
  await restarting;
  await observer.settleAll();
  expect(closeEnvironment).toHaveBeenCalledOnce();
  expect(closeWebsocket).toHaveBeenCalledOnce();
});

it('keeps released configurations terminal across all entry points and saved factories', async () => {
  const failure = new Error('Historical retirement failure');
  const f = fixture(vi.fn().mockRejectedValue(failure));
  await f.initialize();
  const factory = f.config.environments.client!.dev.createEnvironment;
  expect(await f.observer.settle(f.config)).toEqual([failure]);
  expect(f.observer.release(f.config)).toBe(true);
  const action = vi.fn(() => 'returned');
  expect(f.observer.run(f.config, action)).toBe('returned');
  expect(f.observer.dispose(f.config, action)).toBe('returned');
  f.observer.register(f.config);
  await f.observer.boundRestart(f.config, Promise.resolve());
  await factory('client', f.config, { ws: { close: async () => {} } } as never);
  expect(await f.observer.settleStarted(f.config)).toEqual([failure]);
  expect(await f.observer.settle(f.config)).toEqual([failure]);
  expect(await f.observer.settleAll()).toEqual([failure]);
  expect(f.observer.release(f.config)).toBe(false);
  expect(action).toHaveBeenCalledTimes(2);
});

it('records unchanged frozen instrumentation once while discovering a newly writable factory', async () => {
  const plugin = Object.freeze({ name: 'frozen', closeServer: async () => {} });
  const original = vi.fn(async () => ({
    init: async () => {},
    close: async () => {},
  }));
  const dev = Object.defineProperty({}, 'createEnvironment', {
    value: original,
    configurable: true,
    writable: false,
  });
  const config = {
    plugins: [plugin],
    environments: { client: { dev } },
  } as unknown as ResolvedConfig;
  const observer = createViteResourceObserver();
  for (let i = 0; i < 5; i++) observer.prepare(config);
  Object.defineProperty(dev, 'createEnvironment', {
    value: original,
    configurable: true,
    writable: true,
  });
  observer.prepare(config);
  expect(config.environments.client!.dev.createEnvironment).not.toBe(original);
  const failures = await observer.settleAll();
  expect(failures).toHaveLength(2);
  expect(failures.every((error) => error instanceof TypeError)).toBe(true);
});

async function resourceFixture(close: () => Promise<void>) {
  const websocket = { close: vi.fn(async () => {}) };
  const optimizer = { close: vi.fn(async () => {}) };
  const bundled = { close: vi.fn(async () => {}) };
  const closes = {
    websocket: websocket.close,
    optimizer: optimizer.close,
    bundled: bundled.close,
  };
  const environment = {
    hot: websocket,
    depsOptimizer: optimizer,
    bundledDev: bundled,
    init: async () => {},
    close,
  } as unknown as DevEnvironment;
  const config = {
    plugins: [],
    environments: {
      client: { dev: { createEnvironment: async () => environment } },
    },
  } as unknown as ResolvedConfig;
  const observer = createViteResourceObserver();
  observer.register(config);
  await config.environments.client!.dev.createEnvironment('client', config, {
    ws: websocket,
  } as never);
  return {
    observer,
    config,
    environment,
    websocket,
    optimizer,
    bundled,
    closes,
  };
}
it('reserves one retirement across dependent parts and captured closer delegation', async () => {
  const native = vi.fn(async () => {});
  const f = await resourceFixture(native);
  const captured = f.environment.close;
  const wrapper = vi.fn(async () => {
    await captured();
  });
  f.environment.close = wrapper;
  expect(
    await Promise.all([
      f.observer.settle(f.config),
      f.observer.settle(f.config),
    ])
  ).toEqual([[], []]);
  expect(wrapper).toHaveBeenCalledOnce();
  expect(native).toHaveBeenCalledOnce();
  expect(f.closes.optimizer).toHaveBeenCalledOnce();
  expect(f.closes.bundled).toHaveBeenCalledOnce();
  expect(f.closes.websocket).toHaveBeenCalledOnce();
  await f.observer.settleAll();
  expect(wrapper).toHaveBeenCalledOnce();
});
it('closes the independent websocket while a deferred environment wrapper retains its own parts', async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const native = vi.fn(async () => {});
  const f = await resourceFixture(native);
  const previous = f.environment.close;
  const wrapper = vi.fn(async () => {
    entered.resolve();
    await gate.promise;
    await previous();
  });
  f.environment.close = wrapper;
  const finishing = f.observer.settle(f.config);
  try {
    await entered.promise;
    await vi.waitFor(() => expect(f.closes.websocket).toHaveBeenCalledOnce());
    expect(native).not.toHaveBeenCalled();
    expect(f.closes.optimizer).not.toHaveBeenCalled();
    expect(f.closes.bundled).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
  }
  expect(await finishing).toEqual([]);
  expect(wrapper).toHaveBeenCalledOnce();
  expect(native).toHaveBeenCalledOnce();
  expect(f.closes.optimizer).toHaveBeenCalledOnce();
});
it('attempts the native closer once after a reserved wrapper rejects before delegation', async () => {
  const failure = new Error('Outer wrapper rejected');
  const native = vi.fn(async () => {});
  const f = await resourceFixture(native);
  const wrapper = vi.fn(async () => {
    throw failure;
  });
  f.environment.close = wrapper;
  expect(await f.observer.settle(f.config)).toEqual([failure]);
  expect(wrapper).toHaveBeenCalledOnce();
  expect(native).toHaveBeenCalledOnce();
  expect(f.closes.optimizer).toHaveBeenCalledOnce();
  expect(await f.observer.settleAll()).toEqual([failure]);
  expect(wrapper).toHaveBeenCalledOnce();
});
it('drains failed-init parts without waiting recursively on the environment retirement', async () => {
  const startup = new Error('Initialization rejected');
  const cleanup = new Error('Custom close rejected');
  const hot = { close: vi.fn(async () => {}) };
  const hotClose = hot.close;
  const optimizerClose = vi.fn(async () => {});
  const environment = {
    hot,
    depsOptimizer: { close: optimizerClose },
    init: async () => {
      throw startup;
    },
    close: vi.fn(async () => {
      throw cleanup;
    }),
  } as unknown as DevEnvironment;
  const config = {
    plugins: [],
    environments: {
      client: { dev: { createEnvironment: async () => environment } },
    },
  } as unknown as ResolvedConfig;
  const observer = createViteResourceObserver();
  observer.register(config);
  const env = await config.environments.client!.dev.createEnvironment(
    'client',
    config,
    { ws: { close: async () => {} } } as never
  );
  await expect(env.init()).rejects.toBe(startup);
  expect(await observer.settle(config)).toEqual([cleanup]);
  expect(hotClose).toHaveBeenCalledOnce();
  expect(optimizerClose).toHaveBeenCalledOnce();
});
it('coalesces throwing getter episodes while discovering recovery without a descriptor change', async () => {
  let broken = true;
  const failures: Error[] = [];
  const hook = vi.fn(async () => {});
  const plugin = {
    name: 'recovering',
    get closeServer() {
      if (!broken) return hook;
      const error = new Error(`Read failed ${failures.length}`);
      failures.push(error);
      throw error;
    },
    set closeServer(value) {
      Object.defineProperty(this, 'closeServer', {
        value,
        configurable: true,
        writable: true,
      });
    },
  };
  const config = {
    plugins: [plugin],
    environments: {},
  } as unknown as ResolvedConfig;
  const observer = createViteResourceObserver();
  for (let i = 0; i < 5; i++) observer.prepare(config);
  expect(failures).toHaveLength(5);
  broken = false;
  observer.prepare(config);
  await observer.run(config, () => plugin.closeServer());
  expect(hook).toHaveBeenCalledOnce();
  expect(await observer.settle(config)).toEqual([failures[0]]);
});
it('records a new read failure when an inherited accessor owner changes', async () => {
  const first = new Error('First accessor');
  const second = new Error('Replacement accessor');
  const getter = function (this: { reason: Error }) {
    throw this.reason;
  };
  const one = Object.defineProperty({ reason: first }, 'closeServer', {
    get: getter,
  });
  const two = Object.defineProperty({ reason: second }, 'closeServer', {
    get: getter,
  });
  const plugin = Object.assign(Object.create(one), { name: 'inherited' });
  const config = {
    plugins: [plugin],
    environments: {},
  } as unknown as ResolvedConfig;
  const observer = createViteResourceObserver();
  observer.prepare(config);
  Object.setPrototypeOf(plugin, two);
  observer.prepare(config);
  observer.prepare(config);
  expect(await observer.settle(config)).toEqual([first, second]);
});
