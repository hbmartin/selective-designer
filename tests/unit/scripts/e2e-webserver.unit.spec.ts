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
vi.mock('vite', () => ({ createServer: mocks.create }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

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

it('does not restart the initial instance while it is still being constructed', async () => {
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
  await owner.vite.restart();
  expect(rawRestart).toHaveBeenCalledOnce();
  await owner.close();
});
