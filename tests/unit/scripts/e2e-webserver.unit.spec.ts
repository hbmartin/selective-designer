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
    const server = { close: closeVite, listen };
    for (const plugin of config.plugins) await plugin.configureServer?.(server);
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
