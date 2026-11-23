import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  runE2EWebserverCommand,
  startE2EWebserver,
} from '@tests/server/e2e-webserver';

const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  dbClose: vi.fn(),
  socketStart: vi.fn(),
  socketStop: vi.fn(),
  create: vi.fn(),
  spawn: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@electric-sql/pglite', () => ({
  PGlite: class {
    waitReady = mocks.ready();
    close = mocks.dbClose;
  },
}));
vi.mock('@electric-sql/pglite-socket', () => ({
  PGLiteSocketServer: class {
    start = mocks.socketStart;
    stop = mocks.socketStop;
    getServerConn() {
      return '127.0.0.1:45678';
    }
  },
}));
vi.mock('vite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vite')>()),
  createServer: mocks.create,
}));
vi.mock('@tests/server/vite-owned-config', () => ({
  createOwnedViteConfig: async (
    inline: { plugins?: unknown[] },
    plugin: unknown
  ) => ({
    config: { ...inline, plugins: [plugin, ...(inline.plugins ?? [])] },
    remove: async () => {},
  }),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@tests/server/vite-resource-observer', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@tests/server/vite-resource-observer')
    >();
  return {
    ...actual,
    createViteResourceObserver: (
      ...args: Parameters<typeof actual.createViteResourceObserver>
    ) => {
      const observer = actual.createViteResourceObserver(...args);
      const release = observer.release;
      observer.release = (config) => {
        const released = release(config);
        mocks.release(config, released);
        return released;
      };
      return observer;
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const handlers = new Map<string, (...args: unknown[]) => void>();
let closeVite: ReturnType<typeof vi.fn>;
let listen: ReturnType<typeof vi.fn>;
let exit: ReturnType<typeof vi.spyOn>;
let previousExitCode: typeof process.exitCode;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  for (const key of [
    'E2E_DATABASE_URL',
    'DATABASE_URL',
    'DATABASE_DRIVER',
    'DATABASE_MIGRATION_URL',
    'DATABASE_MIGRATION_DRIVER',
  ])
    vi.stubEnv(key, process.env[key]);
  vi.stubEnv('E2E_DATABASE_URL', '');
  handlers.clear();
  const originalOn = process.on.bind(process);
  const originalOff = process.off.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((
    name: string,
    callback: (...args: unknown[]) => void
  ) => {
    if (name === 'SIGINT' || name === 'SIGTERM') {
      handlers.set(name, callback);
      return process;
    }
    return originalOn(name, callback);
  }) as typeof process.on);
  vi.spyOn(process, 'off').mockImplementation(((
    name: string,
    callback: (...args: unknown[]) => void
  ) => {
    if (name === 'SIGINT' || name === 'SIGTERM') {
      handlers.delete(name);
      return process;
    }
    return originalOff(name, callback);
  }) as typeof process.off);
  exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.ready.mockResolvedValue(undefined);
  mocks.dbClose.mockResolvedValue(undefined);
  mocks.socketStart.mockResolvedValue(undefined);
  mocks.socketStop.mockResolvedValue(undefined);
  closeVite = vi.fn(async () => {});
  listen = vi.fn(async () => {});
  mocks.create.mockImplementation(async (config) => {
    const server = {
      config: {},
      close: closeVite,
      listen,
      restart: vi.fn(async () => {}),
    };
    for (const plugin of config.plugins)
      await (typeof plugin.configureServer === 'function'
        ? plugin.configureServer(server)
        : plugin.configureServer?.handler(server));
    return server;
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = previousExitCode;
});

it('bounds and caches programmatic close without terminating or changing its caller status', async () => {
  process.exitCode = 7;
  const release = deferred<void>();
  closeVite.mockReturnValue(release.promise);
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const closing = owner.close();
  expect(owner.close()).toBe(closing);
  await Promise.all([
    expect(closing).rejects.toThrow('resource cleanup exceeded ten seconds'),
    vi.advanceTimersByTimeAsync(10_000),
  ]);
  expect(exit).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(7);
  release.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.dbClose).toHaveBeenCalledOnce();
  expect(owner.close()).toBe(closing);
});
it('does not change caller exit status on a programmatic cleanup failure', async () => {
  process.exitCode = 7;
  const failure = new Error('Close failed');
  closeVite.mockRejectedValue(failure);
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  await expect(owner.close()).rejects.toBe(failure);
  expect(exit).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(7);
});
it('observes a late cleanup rejection after the caller times out', async () => {
  const release = deferred<void>();
  closeVite.mockReturnValue(release.promise);
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  await Promise.all([
    expect(owner.close()).rejects.toThrow('exceeded ten seconds'),
    vi.advanceTimersByTimeAsync(10_000),
  ]);
  release.reject(new Error('Late close failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.dbClose).toHaveBeenCalledOnce();
  expect(exit).not.toHaveBeenCalled();
});
it.each(['SIGINT', 'SIGTERM'] as const)(
  'retains acquisition failure when %s arrives first',
  async (signal) => {
    const entered = deferred<void>();
    const creation = deferred<never>();
    mocks.create.mockImplementation(() => {
      entered.resolve();
      return creation.promise;
    });
    const command = runE2EWebserverCommand({ setupScripts: [] });
    await entered.promise;
    handlers.get(signal)!();
    creation.reject(new Error('Genuine creation failure'));
    await command;
    expect(console.error).toHaveBeenCalledWith(
      'E2E startup failed: Genuine creation failure'
    );
    expect(exit).toHaveBeenCalledWith(1);
  }
);
it.each(['SIGINT', 'SIGTERM'] as const)(
  'retains acquisition failure when it precedes %s',
  async (signal) => {
    const entered = deferred<void>();
    const creation = deferred<never>();
    const closing = deferred<void>();
    mocks.create.mockImplementation(() => {
      entered.resolve();
      return creation.promise;
    });
    mocks.dbClose.mockReturnValue(closing.promise);
    const command = runE2EWebserverCommand({ setupScripts: [] });
    await entered.promise;
    creation.reject(new Error('Genuine creation failure'));
    await vi.advanceTimersByTimeAsync(0);
    handlers.get(signal)!();
    closing.resolve();
    await command;
    expect(exit).toHaveBeenCalledWith(1);
  }
);
it.each(['SIGINT', 'SIGTERM'] as const)(
  'retains a setup nonzero exit racing with %s',
  async (signal) => {
    const entered = deferred<void>();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
    });
    mocks.spawn.mockImplementation(() => {
      entered.resolve();
      return child;
    });
    const command = runE2EWebserverCommand({
      setupScripts: ['synthetic-setup.ts'],
    });
    await entered.promise;
    handlers.get(signal)!();
    await vi.advanceTimersByTimeAsync(0);
    child.emit('close', 2, null);
    await command;
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('synthetic-setup.ts (2)')
    );
    expect(exit).toHaveBeenCalledWith(1);
  }
);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'retains a setup nonzero exit that precedes %s',
  async (signal) => {
    const entered = deferred<void>();
    const cleanup = deferred<void>();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
    });
    mocks.spawn.mockImplementation(() => {
      entered.resolve();
      return child;
    });
    mocks.dbClose.mockReturnValue(cleanup.promise);
    const command = runE2EWebserverCommand({
      setupScripts: ['synthetic-setup.ts'],
    });
    await entered.promise;
    const receiveSignal = handlers.get(signal)!;
    child.emit('close', 2, null);
    await vi.advanceTimersByTimeAsync(0);
    receiveSignal();
    cleanup.resolve();
    await command;
    expect(exit).toHaveBeenCalledWith(1);
  }
);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'retains a programmatic startup failure recorded before %s',
  async (signal) => {
    const entered = deferred<void>();
    const creation = deferred<never>();
    const cleanup = deferred<void>();
    const failure = new Error('Programmatic creation failed');
    mocks.create.mockImplementation(() => {
      entered.resolve();
      return creation.promise;
    });
    mocks.dbClose.mockReturnValue(cleanup.promise);
    const startup = startE2EWebserver({ setupScripts: [] });
    await Promise.all([
      expect(startup).rejects.toBe(failure),
      (async () => {
        await entered.promise;
        creation.reject(failure);
        await vi.advanceTimersByTimeAsync(0);
        expect(process.exitCode).toBeUndefined();
        handlers.get(signal)!();
        cleanup.resolve();
      })(),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(1);
  }
);

it.each(
  (['SIGINT', 'SIGTERM'] as const).flatMap((signal) =>
    ['signal-first', 'child-first'].map((order) => ({ signal, order }))
  )
)(
  'reconciles group $signal cancellation in $order order',
  async ({ signal, order }) => {
    const entered = deferred<void>();
    const cleanup = deferred<void>();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => false),
    });
    mocks.spawn.mockImplementation(() => {
      entered.resolve();
      return child;
    });
    mocks.dbClose.mockReturnValue(cleanup.promise);
    const command = runE2EWebserverCommand({
      setupScripts: ['synthetic-setup.ts'],
    });
    await entered.promise;
    if (order === 'signal-first') handlers.get(signal)!();
    child.emit('close', null, signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).not.toHaveBeenCalled();
    if (order === 'child-first') handlers.get(signal)!();
    cleanup.resolve();
    await command;
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(console.error).not.toHaveBeenCalled();
  }
);
it.each(['SIGSEGV', 'SIGKILL', 'SIGABRT'] as const)(
  'retains unrelated child %s despite launcher cancellation',
  async (signal) => {
    const entered = deferred<void>();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
    });
    mocks.spawn.mockImplementation(() => {
      entered.resolve();
      return child;
    });
    const command = runE2EWebserverCommand({
      setupScripts: ['synthetic-setup.ts'],
    });
    await entered.promise;
    handlers.get('SIGINT')!();
    child.emit('close', null, signal);
    await command;
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`(${signal})`)
    );
  }
);
it('keeps an unmatched signal failure historical after settlement', async () => {
  const entered = deferred<void>();
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => false) });
  mocks.spawn.mockImplementation(() => {
    entered.resolve();
    return child;
  });
  const command = runE2EWebserverCommand({
    setupScripts: ['synthetic-setup.ts'],
  });
  await entered.promise;
  const receiveSignal = handlers.get('SIGINT')!;
  child.emit('close', null, 'SIGINT');
  await command;
  expect(exit).toHaveBeenCalledWith(1);
  receiveSignal();
  await vi.advanceTimersByTimeAsync(0);
  expect(process.exitCode).toBe(1);
  expect(exit).not.toHaveBeenCalledWith(0);
});
it('marks failure without reprinting a previously reported programmatic timeout', async () => {
  const release = deferred<void>();
  closeVite.mockReturnValue(release.promise);
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  await Promise.all([
    expect(owner.close()).rejects.toThrow(
      'resource cleanup exceeded ten seconds'
    ),
    vi.advanceTimersByTimeAsync(10_000),
  ]);
  handlers.get('SIGINT')!();
  await vi.advanceTimersByTimeAsync(0);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    'E2E cleanup failed: E2E resource cleanup exceeded ten seconds'
  );
  expect(exit).not.toHaveBeenCalled();
  release.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(exit).toHaveBeenCalledWith(1);
});
it('retains signal handlers through final flushing and joins repeated interrupts', async () => {
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const callbacks: (() => void)[] = [];
  const holdWrite = (...args: unknown[]) => {
    callbacks.push(args.at(-1) as () => void);
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(holdWrite);
  vi.spyOn(process.stderr, 'write').mockImplementation(holdWrite);
  handlers.get('SIGINT')!();
  await vi.advanceTimersByTimeAsync(0);
  expect(handlers.has('SIGINT')).toBe(true);
  expect(handlers.has('SIGTERM')).toBe(true);
  handlers.get('SIGINT')!();
  handlers.get('SIGTERM')!();
  expect(exit).not.toHaveBeenCalled();
  expect(closeVite).toHaveBeenCalledOnce();
  for (const callback of callbacks) callback();
  await vi.advanceTimersByTimeAsync(0);
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  await owner.close();
});
it('attempts every partial server closure and database cleanup after failures', async () => {
  const first = new Error('Initial server close failed');
  const second = new Error('Partial server close failed');
  closeVite.mockRejectedValue(first);
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const partialClose = vi.fn(async () => {
    throw second;
  });
  const partial = {
    config: {},
    close: partialClose,
    restart: vi.fn(async () => {}),
  };
  await mocks.create.mock.calls[0]![0].plugins[0].configureServer.handler(
    partial
  );
  await expect(owner.close()).rejects.toMatchObject({
    errors: [first, second],
    cause: first,
  });
  expect(partialClose).toHaveBeenCalledOnce();
  expect(mocks.dbClose).toHaveBeenCalledOnce();
  expect(exit).not.toHaveBeenCalled();
});
it('settles an in-flight restart before closing every acquired server', async () => {
  const release = deferred<void>();
  const rawRestart = vi.fn(() => release.promise);
  mocks.create.mockImplementation(async (config) => {
    const server = {
      config: {},
      close: closeVite,
      listen,
      restart: rawRestart,
    };
    for (const plugin of config.plugins)
      await (typeof plugin.configureServer === 'function'
        ? plugin.configureServer(server)
        : plugin.configureServer?.handler(server));
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const restart = owner.vite.restart();
  await vi.advanceTimersByTimeAsync(0);
  const closing = owner.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(closeVite).not.toHaveBeenCalled();
  const partialClose = vi.fn(async () => {});
  await mocks.create.mock.calls[0]![0].plugins[0].configureServer.handler({
    config: {},
    close: partialClose,
    restart: rawRestart,
  });
  release.resolve();
  await Promise.all([restart, closing]);
  expect(closeVite).toHaveBeenCalledOnce();
  expect(partialClose).toHaveBeenCalledOnce();
  await expect(owner.vite.restart()).resolves.toBeUndefined();
  expect(rawRestart).toHaveBeenCalledOnce();
});
it('retains one database failure shared by several final-close hooks', async () => {
  const failure = new Error('Owned database close failed');
  mocks.dbClose.mockRejectedValue(failure);
  let closeHook!: (context: { reason: string }) => Promise<void>;
  mocks.create.mockImplementation(async (config) => {
    closeHook = config.plugins[0].closeServer;
    const server = {
      config: {},
      close: vi.fn(() => closeHook({ reason: 'close' })),
      listen,
      restart: vi.fn(async () => {}),
    };
    for (const plugin of config.plugins)
      await (typeof plugin.configureServer === 'function'
        ? plugin.configureServer(server)
        : plugin.configureServer?.handler(server));
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const partialClose = vi.fn(() => closeHook({ reason: 'close' }));
  await mocks.create.mock.calls[0]![0].plugins[0].configureServer.handler({
    config: {},
    close: partialClose,
    restart: vi.fn(async () => {}),
  });
  await expect(owner.close()).rejects.toBe(failure);
  expect(partialClose).toHaveBeenCalledOnce();
  expect(mocks.dbClose).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    'E2E cleanup failed: Owned database close failed'
  );
});
it('keeps one original failure when restart close callbacks join the same rejected operation', async () => {
  const failure = new Error('Shared active Vite close failed');
  closeVite.mockRejectedValue(failure);
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const joinedClose = vi.fn(async () => {
    throw failure;
  });
  await mocks.create.mock.calls[0]![0].plugins[0].configureServer.handler({
    config: {},
    close: joinedClose,
    restart: vi.fn(async () => {}),
  });
  await expect(owner.close()).rejects.toBe(failure);
  expect(closeVite).toHaveBeenCalledOnce();
  expect(joinedClose).toHaveBeenCalledOnce();
});
it('starts the CLI terminal budget for a provisional child interrupt before launcher delivery', async () => {
  const entered = deferred<void>();
  const cleanup = deferred<void>();
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => false) });
  mocks.spawn.mockImplementation(() => {
    entered.resolve();
    return child;
  });
  mocks.dbClose.mockReturnValue(cleanup.promise);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  void runE2EWebserverCommand({ setupScripts: ['synthetic-setup.ts'] }).catch(
    () => undefined
  );
  await entered.promise;
  child.emit('close', null, 'SIGINT');
  await vi.advanceTimersByTimeAsync(9000);
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('pending after nine seconds')
  );
  expect(process.exitCode).toBe(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(exit).toHaveBeenCalledWith(1);
  cleanup.resolve();
  await vi.advanceTimersByTimeAsync(0);
});

it('retains programmatic startup handlers past timeout until underlying cleanup settles', async () => {
  const startupFailure = new Error('Startup failed');
  const release = deferred<void>();
  listen.mockRejectedValue(startupFailure);
  closeVite.mockReturnValue(release.promise);
  const starting = startE2EWebserver({ setupScripts: [] });
  await Promise.all([
    expect(starting).rejects.toBe(startupFailure),
    vi.advanceTimersByTimeAsync(10_000),
  ]);
  expect(handlers.has('SIGINT')).toBe(true);
  expect(handlers.has('SIGTERM')).toBe(true);
  expect(exit).not.toHaveBeenCalled();
  release.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(handlers.has('SIGINT')).toBe(false);
  expect(handlers.has('SIGTERM')).toBe(false);
});
it.each(['SIGINT', 'SIGTERM'] as const)(
  'joins delayed startup cleanup after a programmatic timeout on %s',
  async (signal) => {
    const failure = new Error('Startup failed');
    const release = deferred<void>();
    listen.mockRejectedValue(failure);
    closeVite.mockReturnValue(release.promise);
    const starting = startE2EWebserver({ setupScripts: [] });
    await Promise.all([
      expect(starting).rejects.toBe(failure),
      vi.advanceTimersByTimeAsync(10_000),
    ]);
    handlers.get(signal)!();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).not.toHaveBeenCalled();
    expect(closeVite).toHaveBeenCalledOnce();
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      'E2E startup failed: Startup failed'
    );
    expect(handlers.has(signal)).toBe(true);
  }
);
it('forces the original retained child if timed-out programmatic startup never finishes after a signal', async () => {
  const entered = deferred<void>();
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  mocks.spawn.mockImplementation(() => {
    entered.resolve();
    return child;
  });
  const starting = startE2EWebserver({ setupScripts: ['synthetic-setup.ts'] });
  await entered.promise;
  const setupFailure = new Error('Setup transport failed');
  child.emit('error', setupFailure);
  // Keep another acquisition pending through database cleanup.
  const release = deferred<void>();
  mocks.dbClose.mockReturnValue(release.promise);
  await Promise.all([
    expect(starting).rejects.toBe(setupFailure),
    vi.advanceTimersByTimeAsync(10_000),
  ]);
  handlers.get('SIGINT')!();
  await vi.advanceTimersByTimeAsync(9_000);
  expect(exit).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('pending after nine seconds')
  );
  await vi.advanceTimersByTimeAsync(1_000);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(exit).toHaveBeenCalledWith(1);
  release.resolve();
  await vi.advanceTimersByTimeAsync(0);
});
it('waits for every server teardown before closing the shared database', async () => {
  const release = deferred<void>();
  closeVite.mockReturnValue(release.promise);
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const hooks = mocks.create.mock.calls[0]![0].plugins[0];
  const partialClose = vi.fn(() => hooks.closeServer({ reason: 'close' }));
  await hooks.configureServer.handler({
    config: {},
    close: partialClose,
    restart: vi.fn(),
  });
  const closing = owner.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(partialClose).toHaveBeenCalledOnce();
  expect(mocks.dbClose).not.toHaveBeenCalled();
  expect(mocks.socketStop).not.toHaveBeenCalled();
  release.resolve();
  await closing;
  expect(mocks.dbClose).toHaveBeenCalledOnce();
});
it('retires an abandoned restart instance before restart resolves while preserving the active database', async () => {
  const retire = deferred<void>();
  const partialClose = vi.fn(() => retire.promise);
  const partialRestart = vi.fn(async () => {});
  let register!: (server: unknown) => void;
  const partial = { config: {}, close: partialClose, restart: partialRestart };
  const rawRestart = vi.fn(async () => {
    register(partial);
  });
  mocks.create.mockImplementation(async (config) => {
    register = config.plugins[0].configureServer.handler;
    const server = {
      config: {},
      close: closeVite,
      listen,
      restart: rawRestart,
    };
    register(server);
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  let settled = false;
  const restart = owner.vite.restart().then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(partialClose).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  await partial.restart();
  expect(partialRestart).not.toHaveBeenCalled();
  expect(mocks.dbClose).not.toHaveBeenCalled();
  retire.resolve();
  await restart;
  expect(closeVite).not.toHaveBeenCalled();
  await owner.close();
  expect(partialClose).toHaveBeenCalledOnce();
});
it('surfaces retirement failures and retains them for final cleanup without closing active resources early', async () => {
  const failure = new Error('Partial retirement failed');
  const partialClose = vi.fn(async () => {
    throw failure;
  });
  let register!: (server: unknown) => void;
  const rawRestart = vi.fn(async () => {
    register({ config: {}, close: partialClose, restart: vi.fn() });
  });
  mocks.create.mockImplementation(async (config) => {
    register = config.plugins[0].configureServer.handler;
    const server = {
      config: {},
      close: closeVite,
      listen,
      restart: rawRestart,
    };
    register(server);
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  await expect(owner.vite.restart()).rejects.toBe(failure);
  expect(closeVite).not.toHaveBeenCalled();
  expect(mocks.dbClose).not.toHaveBeenCalled();
  await expect(owner.close()).rejects.toBe(failure);
  expect(closeVite).toHaveBeenCalledOnce();
  expect(partialClose).toHaveBeenCalledOnce();
});
it('registers ownership as a pre plugin with a pre configure hook', async () => {
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const hooks = mocks.create.mock.calls[0]![0].plugins[0];
  expect(hooks.enforce).toBe('pre');
  expect(hooks.configureServer.order).toBe('pre');
  await owner.close();
  await expect(owner.vite.restart()).resolves.toBeUndefined();
  expect(console.error).not.toHaveBeenCalled();
});

it('serializes queued restart requests behind abandoned-instance retirement', async () => {
  const retire = deferred<void>();
  const partialClose = vi.fn(() => retire.promise);
  let register!: (server: unknown) => void;
  const rawRestart = vi.fn(async () => {
    register({ config: {}, close: partialClose, restart: vi.fn() });
  });
  mocks.create.mockImplementation(async (config) => {
    register = config.plugins[0].configureServer.handler;
    const server = {
      config: {},
      close: closeVite,
      listen,
      restart: rawRestart,
    };
    register(server);
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const first = owner.vite.restart();
  await vi.advanceTimersByTimeAsync(0);
  const queued = owner.vite.restart(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(rawRestart).toHaveBeenCalledOnce();
  retire.resolve();
  await Promise.all([first, queued]);
  expect(rawRestart).toHaveBeenCalledTimes(2);
  expect(rawRestart).toHaveBeenLastCalledWith(true);
  await owner.close();
});

it('retains force optimization when restart requests coalesce before creation starts', async () => {
  const rawRestart = vi.fn(async () => {});
  mocks.create.mockImplementation(async (config) => {
    const server = {
      config: {},
      close: closeVite,
      listen,
      restart: rawRestart,
    };
    await config.plugins[0].configureServer.handler(server);
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  await Promise.all([owner.vite.restart(), owner.vite.restart(true)]);
  expect(rawRestart).toHaveBeenCalledExactlyOnceWith(true);
  await owner.close();
});

it('acknowledges a startup restart without deadlocking and runs it after readiness', async () => {
  const rawRestart = vi.fn(async () => {});
  mocks.create.mockImplementation(async (config) => {
    const server = {
      config: {},
      close: closeVite,
      listen,
      restart: rawRestart,
    };
    await config.plugins[0].configureServer.handler(server);
    await server.restart();
    expect(rawRestart).not.toHaveBeenCalled();
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  await vi.advanceTimersByTimeAsync(0);
  expect(rawRestart).toHaveBeenCalledOnce();
  await owner.close();
});

it('clears queued force options after a failed retirement batch', async () => {
  const retiring = deferred<void>();
  const partialClose = vi.fn(() => retiring.promise);
  let register!: (server: unknown) => void;
  const rawRestart = vi.fn(async () => {
    if (rawRestart.mock.calls.length === 1)
      register({ config: {}, close: partialClose, restart: vi.fn() });
  });
  mocks.create.mockImplementation(async (config) => {
    register = config.plugins[0].configureServer.handler;
    const server = {
      config: {},
      close: closeVite,
      listen,
      restart: rawRestart,
    };
    register(server);
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const first = owner.vite.restart();
  await vi.advanceTimersByTimeAsync(0);
  const queued = owner.vite.restart(true);
  const failure = new Error('Retirement failure');
  const settled = Promise.allSettled([first, queued]);
  retiring.reject(failure);
  expect(await settled).toEqual([
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure },
  ]);
  // The failed candidate is retired once; later batches report their own outcome.
  await expect(owner.vite.restart()).resolves.toBeUndefined();
  expect(rawRestart).toHaveBeenLastCalledWith();
  expect(partialClose).toHaveBeenCalledOnce();
  await expect(owner.close()).rejects.toBe(failure);
});
it('preserves queued requests after timeout and waits for candidate cleanup', async () => {
  const hung = deferred<void>();
  const partialClose = vi.fn(() => hung.promise);
  let register!: (server: unknown) => void;
  const rawRestart = vi.fn(async () => {
    if (rawRestart.mock.calls.length === 1)
      register({ config: {}, close: partialClose, restart: vi.fn() });
  });
  mocks.create.mockImplementation(async (config) => {
    register = config.plugins[0].configureServer.handler;
    const server = {
      config: {},
      close: closeVite,
      listen,
      restart: rawRestart,
    };
    register(server);
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  await Promise.all([
    expect(owner.vite.restart()).rejects.toThrow(
      'E2E Vite retirement exceeded five seconds'
    ),
    vi.advanceTimersByTimeAsync(5000),
  ]);
  await expect(owner.vite.restart(true)).rejects.toThrow('retirement exceeded');
  expect(rawRestart).toHaveBeenCalledOnce();
  expect(partialClose).toHaveBeenCalledOnce();
  hung.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(rawRestart).toHaveBeenCalledTimes(2);
  expect(rawRestart).toHaveBeenLastCalledWith(true);
  await owner.close();
  expect(closeVite).toHaveBeenCalledOnce();
});
it('releases cleanly retired candidates and replaced instances', async () => {
  let register!: (server: unknown) => void;
  let server!: { config: object } & Record<string, unknown>;
  const candidateConfig = { generation: 'abandoned' };
  const replacementConfig = { generation: 'replacement' };
  const replacementClose = vi.fn(async () => {});
  const rawRestart = vi.fn(async () => {
    if (rawRestart.mock.calls.length === 1) {
      register({
        config: candidateConfig,
        close: vi.fn(async () => {}),
        restart: vi.fn(),
      });
      return;
    }
    // Vite transfers the adopted replacement onto the original server object.
    const replacement = {
      config: replacementConfig,
      close: replacementClose,
      listen,
      restart: vi.fn(async () => {}),
    };
    register(replacement);
    Object.assign(server, {
      config: replacement.config,
      close: replacement.close,
      restart: replacement.restart,
    });
  });
  mocks.create.mockImplementation(async (config) => {
    register = config.plugins[0].configureServer.handler;
    server = { config: {}, close: closeVite, listen, restart: rawRestart };
    register(server);
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const initialConfig = owner.vite.config;
  await owner.vite.restart();
  expect(mocks.release).toHaveBeenCalledWith(candidateConfig, true);
  await owner.vite.restart();
  expect(owner.vite.config).toBe(replacementConfig);
  expect(mocks.release).toHaveBeenCalledWith(initialConfig, true);
  expect(mocks.release).not.toHaveBeenCalledWith(
    replacementConfig,
    expect.anything()
  );
  await owner.close();
  expect(replacementClose).toHaveBeenCalledOnce();
  expect(closeVite).not.toHaveBeenCalled();
});
it('does not lose restart requests at the queue-drained microtask boundary', async () => {
  for (let turns = 0; turns < 20; turns++) {
    vi.stubEnv('E2E_DATABASE_URL', '');
    let owner!: NonNullable<Awaited<ReturnType<typeof startE2EWebserver>>>;
    let late: Promise<void> | undefined;
    const rawRestart = vi.fn(async () => {
      if (rawRestart.mock.calls.length !== 1) return;
      let pending = Promise.resolve();
      for (let n = 0; n < turns; n++) pending = pending.then(() => {});
      void pending.then(() => {
        late = owner.vite.restart(true);
      });
    });
    mocks.create.mockImplementation(async (config) => {
      const server = {
        config: {},
        close: vi.fn(async () => {}),
        listen,
        restart: rawRestart,
      };
      config.plugins[0].configureServer.handler(server);
      return server;
    });
    owner = (await startE2EWebserver({ setupScripts: [] }))!;
    await owner.vite.restart();
    for (let n = 0; n < 30; n++) await Promise.resolve();
    await late;
    expect(rawRestart).toHaveBeenCalledTimes(2);
    await owner.close();
  }
});
it('waits for a delayed sibling hook after Vite close rejects before releasing the database', async () => {
  const delayed = deferred<void>();
  const first = new Error('First hook failed');
  const second = new Error('Sibling hook failed');
  mocks.create.mockImplementation(async (inline) => {
    const plugins = [
      {
        name: 'first',
        closeServer: () => {
          throw first;
        },
      },
      { name: 'second', closeServer: () => delayed.promise },
    ];
    const config = { environments: {}, plugins };
    const server = {
      config,
      close: () => Promise.all(plugins.map((plugin) => plugin.closeServer())),
      listen,
      restart: vi.fn(),
    };
    inline.plugins[0].configureServer.handler(server);
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const closing = owner.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.dbClose).not.toHaveBeenCalled();
  await Promise.all([
    expect(closing).rejects.toMatchObject({
      errors: [first, second],
      cause: first,
    }),
    Promise.resolve().then(() => delayed.reject(second)),
  ]);
  expect(mocks.dbClose).toHaveBeenCalledOnce();
});

it('does not retry native failures or replay queued work after a genuine failure', async () => {
  const failure = Object.assign(new Error('Watcher busy'), { code: 'EBUSY' });
  const nativeClose = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(undefined);
  let register!: (server: unknown) => void;
  const rawRestart = vi.fn(async () => {
    if (rawRestart.mock.calls.length !== 1) return;
    const watcher = { close: nativeClose };
    const environment = { init: async () => {}, close: async () => {} };
    const config = {
      getSortedPlugins: () => [],
      environments: {
        client: { dev: { createEnvironment: async () => environment } },
      },
    };
    register({
      config,
      close: async () => {
        await Promise.allSettled([watcher.close()]);
      },
      restart: vi.fn(),
    });
    const resolved = config as unknown as import('vite').ResolvedConfig;
    const env = await resolved.environments.client!.dev.createEnvironment(
      'client',
      resolved,
      { ws: { close: async () => {} } } as never
    );
    await env.init({ watcher } as never);
  });
  mocks.create.mockImplementation(async (config) => {
    register = config.plugins[0].configureServer.handler;
    const server = {
      config: {},
      close: closeVite,
      listen,
      restart: rawRestart,
    };
    register(server);
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const first = owner.vite.restart();
  await Promise.all([
    expect(first).rejects.toBe(failure),
    vi.advanceTimersByTimeAsync(0),
  ]);
  expect(nativeClose).toHaveBeenCalledOnce();
  expect(rawRestart).toHaveBeenCalledOnce();
  await expect(owner.vite.restart()).resolves.toBeUndefined();
  expect(rawRestart).toHaveBeenLastCalledWith();
  await expect(owner.close()).rejects.toBe(failure);
});

function restartResources() {
  const watcher = { close: vi.fn(async () => {}) };
  const environment = { init: async () => {}, close: async () => {} };
  const config = {
    plugins: [] as object[],
    environments: {
      client: { dev: { createEnvironment: async () => environment } },
    },
  };
  async function initialize() {
    const resolved = config as unknown as import('vite').ResolvedConfig;
    const env = await resolved.environments.client!.dev.createEnvironment(
      'client',
      resolved,
      { ws: { close: async () => {} } } as never
    );
    await env.init({ watcher } as never);
  }
  return { config, watcher, initialize };
}
it('does not charge healthy replacement listening to the retirement deadline', async () => {
  const resources = restartResources();
  const listening = deferred<void>();
  let marker!: () => Promise<void>;
  const raw = vi.fn(async () => {
    await resources.watcher.close();
    await marker();
    await listening.promise;
  });
  mocks.create.mockImplementation(async (inline) => {
    resources.config.plugins = inline.plugins;
    const server = {
      config: resources.config,
      close: closeVite,
      listen,
      restart: raw,
    };
    inline.plugins[0].configureServer.handler(server);
    marker = () => inline.plugins[0].closeServer({ reason: 'restart' });
    await resources.initialize();
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  let outcome = 'pending';
  const restart = owner.vite.restart().then(
    () => {
      outcome = 'fulfilled';
    },
    () => {
      outcome = 'rejected';
    }
  );
  await vi.advanceTimersByTimeAsync(6_000);
  expect(outcome).toBe('pending');
  listening.resolve();
  await restart;
  expect(outcome).toBe('fulfilled');
  await owner.close();
});
it('reconciles late adoption before resuming a queued restart without closing its live replacement', async () => {
  const resources = restartResources();
  const release = deferred<void>();
  resources.watcher.close.mockImplementation(() => release.promise);
  let register!: (server: object) => void;
  let marker!: () => Promise<void>;
  let stable!: {
    config: object;
    close: () => Promise<void>;
    listen: typeof listen;
    restart: (...args: unknown[]) => Promise<void>;
  };
  const closeLive = vi.fn(async () => {});
  const second = vi.fn(async () => {});
  const first = vi.fn(async () => {
    const replacement = {
      config: {},
      close: closeLive,
      restart: second,
      listen,
    };
    register(replacement);
    await resources.watcher.close();
    await marker();
    Object.assign(stable, replacement);
  });
  const dangerousAlias = vi.fn(async () => {
    await closeLive();
  });
  mocks.create.mockImplementation(async (inline) => {
    register = inline.plugins[0].configureServer.handler;
    resources.config.plugins = inline.plugins;
    stable = {
      config: resources.config,
      close: dangerousAlias,
      listen,
      restart: first,
    };
    register(stable);
    marker = () => inline.plugins[0].closeServer({ reason: 'restart' });
    await resources.initialize();
    return stable;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  const start = owner.vite.restart();
  await Promise.all([
    expect(start).rejects.toThrow('retirement exceeded'),
    vi.advanceTimersByTimeAsync(5_000),
  ]);
  await expect(owner.vite.restart(true)).rejects.toThrow('retirement exceeded');
  expect(second).not.toHaveBeenCalled();
  release.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(second).toHaveBeenCalledExactlyOnceWith(true);
  expect(dangerousAlias).not.toHaveBeenCalled();
  expect(closeLive).not.toHaveBeenCalled();
  await owner.close();
  expect(closeLive).toHaveBeenCalledOnce();
});
it('queues an incoming generation restart even when its lifecycle hook awaits acceptance', async () => {
  let register!: (server: object) => void;
  let stable!: {
    config: object;
    close: typeof closeVite;
    listen: typeof listen;
    restart: (...args: unknown[]) => Promise<void>;
  };
  const next = vi.fn(async (_force?: boolean) => {});
  const raw = vi.fn(async () => {
    const incoming = { config: {}, close: closeVite, listen, restart: next };
    register(incoming);
    await incoming.restart(true);
    Object.assign(stable, incoming);
  });
  mocks.create.mockImplementation(async (inline) => {
    register = inline.plugins[0].configureServer.handler;
    stable = { config: {}, close: closeVite, listen, restart: raw };
    register(stable);
    return stable;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  await owner.vite.restart();
  expect(raw).toHaveBeenCalledOnce();
  expect(next).toHaveBeenCalledExactlyOnceWith(true);
  await owner.close();
});
it('gives new callers a current result after a timed-out operation finishes reconciling', async () => {
  const retirement = deferred<void>();
  const laterListen = deferred<void>();
  const candidateClose = vi.fn(() => retirement.promise);
  let register!: (server: object) => void;
  const raw = vi.fn(async () => {
    if (raw.mock.calls.length === 1)
      register({ config: {}, close: candidateClose, restart: vi.fn() });
    if (raw.mock.calls.length === 2) await laterListen.promise;
  });
  mocks.create.mockImplementation(async (inline) => {
    register = inline.plugins[0].configureServer.handler;
    const server = { config: {}, close: closeVite, listen, restart: raw };
    register(server);
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  await Promise.all([
    expect(owner.vite.restart()).rejects.toThrow('retirement exceeded'),
    vi.advanceTimersByTimeAsync(5000),
  ]);
  await expect(owner.vite.restart(true)).rejects.toThrow('retirement exceeded');
  retirement.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(raw).toHaveBeenCalledTimes(2);
  const current = owner.vite.restart();
  let settled = false;
  const result = current.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  laterListen.resolve();
  await result;
  expect(raw).toHaveBeenCalledTimes(3);
  await owner.close();
});
it('keeps the original retirement deadline after native restart rejects before a sibling hook settles', async () => {
  const resources = restartResources();
  const sibling = deferred<void>();
  const failure = new Error('Native close hook failed');
  let closeHooks!: () => Promise<unknown>;
  const raw = vi.fn(async () => {
    await resources.watcher.close();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await closeHooks();
  });
  mocks.create.mockImplementation(async (inline) => {
    const plugins = [
      ...inline.plugins,
      {
        name: 'failed',
        closeServer: async () => {
          throw failure;
        },
      },
      { name: 'sibling', closeServer: () => sibling.promise },
    ];
    resources.config.plugins = plugins;
    const server = {
      config: resources.config,
      close: closeVite,
      listen,
      restart: raw,
    };
    inline.plugins[0].configureServer.handler(server);
    closeHooks = () =>
      Promise.all(
        plugins.map((plugin) => plugin.closeServer({ reason: 'restart' }))
      );
    await resources.initialize();
    return server;
  });
  const owner = (await startE2EWebserver({ setupScripts: [] }))!;
  let diagnostic: unknown;
  const restarting = owner.vite.restart().catch((error) => {
    diagnostic = error;
  });
  try {
    await vi.advanceTimersByTimeAsync(5000);
    expect(diagnostic).toMatchObject({
      message: 'E2E Vite retirement exceeded five seconds',
    });
  } finally {
    sibling.resolve();
    await restarting;
    await owner.close().catch(() => {});
  }
});

async function startCandidates(
  ...candidates: { config: object; close: () => Promise<void> }[]
) {
  let register!: (server: object) => void;
  const raw = vi.fn(async () => {
    for (const candidate of candidates)
      register({ ...candidate, restart: vi.fn() });
  });
  mocks.create.mockImplementation(async (inline) => {
    register = inline.plugins[0].configureServer.handler;
    const server = { config: {}, close: closeVite, listen, restart: raw };
    register(server);
    return server;
  });
  return (await startE2EWebserver({ setupScripts: [] }))!;
}
it('releases each clean candidate while a sibling hangs and releases late success without another restart', async () => {
  const delayed = deferred<void>();
  const cleanConfig = {};
  const delayedConfig = {};
  const owner = await startCandidates(
    { config: delayedConfig, close: () => delayed.promise },
    { config: cleanConfig, close: async () => {} }
  );
  const restarting = owner.vite.restart().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith(cleanConfig, true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await restarting).toMatchObject({
    message: 'E2E Vite retirement exceeded five seconds',
  });
  delayed.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.release).toHaveBeenCalledWith(delayedConfig, true);
  await owner.close();
});
it('logs a restart timeout once and exits zero after late cleanup succeeds during SIGTERM shutdown', async () => {
  const delayed = deferred<void>();
  const owner = await startCandidates({
    config: {},
    close: () => delayed.promise,
  });
  const restarting = owner.vite.restart().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  handlers.get('SIGTERM')!();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await restarting).toMatchObject({
    message: 'E2E Vite retirement exceeded five seconds',
  });
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    'E2E cleanup failed: E2E Vite retirement exceeded five seconds'
  );
  delayed.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);
});
it('retains a late cleanup failure during SIGTERM after the restart caller times out', async () => {
  const delayed = deferred<void>();
  const failure = new Error('Late retirement failure');
  const owner = await startCandidates({
    config: {},
    close: () => delayed.promise,
  });
  const restarting = owner.vite.restart().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  handlers.get('SIGTERM')!();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await restarting).toMatchObject({
    message: 'E2E Vite retirement exceeded five seconds',
  });
  delayed.reject(failure);
  await vi.advanceTimersByTimeAsync(0);
  await expect(owner.close()).rejects.toBe(failure);
  expect(exit).toHaveBeenCalledWith(1);
});
