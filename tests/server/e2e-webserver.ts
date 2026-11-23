import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { InlineConfig, ViteDevServer } from 'vite';

import { beforeDeadline } from '../support/promise-deadline';
import { configureE2EDatabase } from './e2e-database-config';
import { createE2ETerminal, flushE2EOutput } from './e2e-terminal';
import { createOwnedViteConfig } from './vite-owned-config';
import {
  createViteResourceObserver,
  ViteRetirementTimeout,
} from './vite-resource-observer';

const setupScripts = [
  'src/platform/env/client.ts',
  'scripts/validate-server-config.ts',
  'src/modules/kernel/infrastructure/db/migrate-cli.ts',
  'drizzle/seed/index.ts',
  'src/app/build-info/infrastructure/generate-build-info.ts',
] as const;

type OwnedViteInstance = {
  token: object;
  data?: {
    config: ViteDevServer['config'];
    close: () => Promise<void>;
    restart: ViteDevServer['restart'];
  };
  settled?: boolean;
  adopted: boolean;
  closing?: Promise<{ native: unknown[]; observed: unknown[] }>;
  replaced: boolean;
};
type RestartRequest = ReturnType<typeof Promise.withResolvers<void>> & {
  eligible: boolean;
  force?: boolean;
};
type RestartBatch = { requests: Map<object, RestartRequest>; expired: boolean };
type RestartOperation = {
  source: object;
  retired?: Promise<unknown[]>;
  deadline?: number;
};
class E2ERestartCancelled extends Error {
  constructor() {
    super('E2E restart cancelled before starting');
  }
}

type E2EWebserverOptions = {
  setupScripts?: readonly string[];
  viteConfig?: InlineConfig;
  /** In-process fixtures may request an OS-assigned port; environment input stays strict. */
  databasePort?: number;
  onDatabaseReady?: (databaseUrl: string) => void;
};

class E2EStartupCancelled extends Error {
  constructor() {
    super('E2E startup cancelled');
  }
}

class E2ESetupSignal extends Error {
  constructor(
    script: string,
    readonly signal: NodeJS.Signals
  ) {
    super(`E2E setup failed: ${script} (${signal})`);
  }
}

export function startE2EWebserver(options: E2EWebserverOptions = {}) {
  return startOwnedWebserver(options);
}

/** The executable boundary also exits on startup failure with lingering handles. */
export async function runE2EWebserverCommand(
  options: E2EWebserverOptions = {}
) {
  const terminal = createE2ETerminal();
  try {
    return await startOwnedWebserver(options, terminal);
  } catch (error) {
    terminal.fail(error, 'E2E startup failed');
    return terminal.finish();
  }
}

async function startOwnedWebserver(
  options: E2EWebserverOptions,
  commandTerminal?: ReturnType<typeof createE2ETerminal>
) {
  const config = configureE2EDatabase();
  const terminal = commandTerminal ?? createE2ETerminal();
  let database: PGlite | undefined;
  let socket: PGLiteSocketServer | undefined;
  let vite: ViteDevServer | undefined;
  let configuration:
    | Awaited<ReturnType<typeof createOwnedViteConfig>>
    | undefined;
  const restartContext = new AsyncLocalStorage<{
    active: boolean;
    operation?: RestartOperation;
  }>();
  const closeContext = new AsyncLocalStorage<{
    operation: object;
    target: object;
    purpose: 'retirement' | 'shutdown';
  }>();
  const observer = createViteResourceObserver({
    onListen(server) {
      if (server === vite) confirmAdoption();
    },
    onBegin(deadline) {
      const operation = restartContext.getStore()?.operation;
      if (operation) operation.deadline ??= deadline;
    },
  });
  const listenWrappers = new WeakSet<Function>();
  const startupContext = { active: true };
  const historicalCleanup = new Set<unknown>();
  let child: ChildProcess | undefined;
  let childResult: Promise<void> | undefined;
  const requestedChildSignals = new Set<NodeJS.Signals>();
  const receivedSignals = new Set<NodeJS.Signals>();
  const instances = new Map<object, OwnedViteInstance>();
  let restarting: Promise<void> | undefined;
  let queuedRestart: RestartBatch | undefined;
  let serverCleanup: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let cleanupSettled = false;
  let acquiring: Promise<unknown> | undefined;
  let stopped = false;
  let databaseCleanup: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  let signalShutdown: Promise<never> | undefined;
  let startupFailure: { error: unknown } | undefined;
  let pendingChildSignal: E2ESetupSignal | undefined;
  let startupSettled = false;

  terminal.setForceStop(() => {
    child?.kill('SIGKILL');
  });

  function recordStartupFailure(error: unknown) {
    if (error instanceof E2EStartupCancelled) return;
    if (
      error instanceof E2ESetupSignal &&
      (error.signal === 'SIGINT' || error.signal === 'SIGTERM')
    ) {
      pendingChildSignal = error;
      // Start the CLI's one terminal budget without declaring a provisional
      // interrupt a failure. Programmatic callers still own their exit status.
      commandTerminal?.begin();
      return;
    }
    recordGenuineStartupFailure(error);
  }
  function recordGenuineStartupFailure(error: unknown) {
    startupFailure ??= { error };
    if (commandTerminal || terminal.active)
      terminal.fail(error, 'E2E startup failed');
  }
  function isCancelledSignal(error: E2ESetupSignal) {
    return (
      receivedSignals.has(error.signal) ||
      requestedChildSignals.has(error.signal)
    );
  }
  function reconcileChildSignal() {
    if (pendingChildSignal && !isCancelledSignal(pendingChildSignal))
      recordGenuineStartupFailure(pendingChildSignal);
  }
  function recordCleanupFailure(error: unknown) {
    if (terminal.active) terminal.fail(error, 'E2E cleanup failed');
    else terminal.report(error, 'E2E cleanup failed');
  }
  function closeDatabase() {
    databaseCleanup ??= (async () => {
      try {
        await socket?.stop();
      } finally {
        await database?.close();
      }
    })();
    return databaseCleanup;
  }
  async function settleStartupOperation() {
    // Never await the outer startup promise: its error path joins close().
    await Promise.allSettled([acquiring, childResult, restarting]);
  }
  function removeReusableHandlers() {
    if (terminal.active || !startupSettled || !cleanupSettled) return;
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
  function throwFailures(failures: unknown[], message: string) {
    const unique = [...new Set(failures)];
    if (unique.length === 1) throw unique[0];
    if (unique.length > 1)
      throw new AggregateError(unique, message, { cause: unique[0] });
  }
  function currentInstance() {
    return [...instances.values()].find(
      (instance) => instance.data?.config === vite?.config
    );
  }
  function liveData(token: object) {
    const data = instances.get(token)?.data;
    if (!data) throw new Error('E2E Vite generation is no longer owned');
    return data;
  }
  function closeInstance(token: object, purpose: 'retirement' | 'shutdown') {
    const instance = instances.get(token)!;
    instance.closing ??= closeContext.run(
      { operation: {}, target: token, purpose },
      async () => {
        const operation = restartContext.getStore()?.operation;
        if (operation) operation.deadline ??= performance.now() + 5_000;
        const native = await Promise.resolve()
          .then(() =>
            observer.run(liveData(token).config, liveData(token).close)
          )
          .then(
            () => [],
            (error: unknown) => [error]
          );
        const observed = await observer.settle(liveData(token).config);
        for (const error of [...native, ...observed]) {
          historicalCleanup.add(error);
          recordCleanupFailure(error);
        }
        instance.settled = true;
        pruneRetired();
        return { native, observed };
      }
    );
    return instance.closing;
  }
  function pruneRetired() {
    for (const [token, candidate] of instances) {
      if (candidate.data?.config === vite?.config || !candidate.settled)
        continue;
      observer.release(candidate.data!.config);
      candidate.data = undefined;
      instances.delete(token);
    }
  }
  async function closeInstances(
    selected: object[],
    purpose: 'retirement' | 'shutdown'
  ) {
    const outcomes = await Promise.allSettled(
      selected.map((token) =>
        closeInstance(
          token,
          purpose === 'shutdown' && currentInstance()?.token === token
            ? 'shutdown'
            : 'retirement'
        )
      )
    );
    return [
      ...outcomes.flatMap((outcome) =>
        outcome.status === 'fulfilled'
          ? outcome.value.native
          : [outcome.reason as unknown]
      ),
      ...outcomes.flatMap((outcome) =>
        outcome.status === 'fulfilled' ? outcome.value.observed : []
      ),
    ];
  }
  function settleRetired(token: object) {
    return observer.settle(liveData(token).config).then((errors) => {
      const instance = instances.get(token);
      if (instance) instance.settled = true;
      pruneRetired();
      return errors;
    });
  }
  function confirmAdoption() {
    const incoming = currentInstance();
    if (!incoming) return;
    incoming.adopted = true;
    const queued = queuedRestart?.requests.get(incoming.token);
    if (queued) queued.eligible = true;
    const operation = restartContext.getStore()?.operation;
    if (!operation || operation.source === incoming.token) return;
    const predecessor = instances.get(operation.source);
    if (!predecessor || predecessor.replaced) return;
    predecessor.replaced = true;
    operation.retired = settleRetired(predecessor.token);
  }
  function invokeNativeRestart(
    token: object,
    args: Parameters<ViteDevServer['restart']>
  ) {
    return observer.run(liveData(token).config, () =>
      liveData(token).restart(...args)
    );
  }
  async function restartInstance(
    token: object,
    args: Parameters<ViteDevServer['restart']>,
    timeout: (error: unknown) => void
  ) {
    const failures: unknown[] = [];
    const operation: RestartOperation = { source: token };
    const operationContext = { active: true, operation };
    try {
      await configuration?.refresh();
      const native = restartContext.run(operationContext, () =>
        Promise.resolve().then(() => invokeNativeRestart(token, args))
      );
      try {
        await observer.boundRestart(liveData(token).config, native);
      } catch (error) {
        if (error instanceof ViteRetirementTimeout) timeout(error);
      }
      try {
        await native;
      } catch (error) {
        failures.push(error);
      }
      // Public listen observes adoption early; this also reconciles native exits
      // before listening and synthetic implementations with no listening phase.
      restartContext.run(operationContext, confirmAdoption);
      const candidates = [...instances.values()]
        .filter(
          (candidate) =>
            !candidate.replaced &&
            !candidate.closing &&
            candidate.data?.config !== vite?.config
        )
        .map((candidate) => candidate.token);
      const pending = restartContext.run(operationContext, async () => {
        const results = await Promise.all([
          operation.retired ?? observer.settleStarted(liveData(token).config),
          closeInstances(candidates, 'retirement'),
          observer.settleOrphans(),
        ]);
        return results.flat();
      });
      try {
        await beforeDeadline(
          pending,
          operation.deadline ?? performance.now() + 5_000,
          'E2E Vite retirement exceeded five seconds'
        );
      } catch (error) {
        timeout(error);
      }
      const retirementFailures = await pending;
      for (const error of retirementFailures) {
        historicalCleanup.add(error);
        recordCleanupFailure(error);
      }
      failures.push(...retirementFailures);
      pruneRetired();
      throwFailures(failures, 'E2E Vite restart failed');
    } finally {
      operationContext.active = false;
    }
  }
  function settleBatch(batch: RestartBatch, failure?: { error: unknown }) {
    for (const request of batch.requests.values()) {
      if (failure) request.reject(failure.error);
      else request.resolve();
    }
  }
  function cancelQueued(error: unknown) {
    if (!queuedRestart) return;
    settleBatch(queuedRestart, { error });
    queuedRestart = undefined;
  }
  function startRestartQueue() {
    if (restarting || stopped || !startupSettled || !queuedRestart) return;
    const operation = Promise.resolve().then(async () => {
      try {
        while (queuedRestart && !stopped) {
          const batch = queuedRestart;
          queuedRestart = undefined;
          for (const [token, request] of batch.requests) {
            if (!request.eligible && !instances.get(token)?.adopted) {
              request.resolve();
              batch.requests.delete(token);
            }
          }
          if (!batch.requests.size) continue;
          const requests = [...batch.requests.values()];
          const args: Parameters<ViteDevServer['restart']> = requests.some(
            (request) => request.force !== undefined
          )
            ? [requests.some((request) => request.force === true)]
            : [];
          try {
            await restartInstance(currentInstance()!.token, args, (error) => {
              if (!batch.expired) terminal.report(error, 'E2E cleanup failed');
              batch.expired = true;
              settleBatch(batch, { error });
            });
            settleBatch(batch);
          } catch (error) {
            settleBatch(batch, { error });
            cancelQueued(error);
            throw error;
          }
        }
      } finally {
        // Queue observation and release remain atomic, including failure paths.
        restarting = undefined;
      }
    });
    restarting = operation;
    void operation.catch(() => {});
  }
  function requestRestart(
    token: object,
    args: Parameters<ViteDevServer['restart']>
  ): Promise<void> {
    const instance = instances.get(token);
    if (stopped || !instance || instance.replaced || instance.closing)
      return Promise.resolve();
    queuedRestart ??= { requests: new Map(), expired: false };
    let request = queuedRestart.requests.get(token);
    if (!request) {
      request = {
        ...Promise.withResolvers<void>(),
        eligible: instance.adopted,
        force: args[0],
      };
      void request.promise.catch(() => {});
      queuedRestart.requests.set(token, request);
    } else if (args[0] !== undefined)
      request.force = !!request.force || args[0];
    startRestartQueue();
    if (!startupSettled || restartContext.getStore()?.active)
      return Promise.resolve();
    return request.promise;
  }
  function closeOwnedServers() {
    serverCleanup ??= (async () => {
      await settleStartupOperation();
      const failures = await closeInstances(
        [...instances.values()]
          .filter((instance) => !instance.replaced)
          .map((instance) => instance.token),
        'shutdown'
      );
      failures.push(...historicalCleanup, ...(await observer.settleAll()));
      try {
        await closeDatabase();
      } catch (error) {
        failures.push(error);
      }
      // Settled historical failures do not require the configuration bridge.
      try {
        await configuration?.remove();
      } catch (error) {
        failures.push(error);
      }
      for (const instance of instances.values()) instance.data = undefined;
      instances.clear();
      throwFailures(failures, 'E2E owned resource cleanup failed');
    })();
    return serverCleanup;
  }
  function close() {
    stopped = true;
    cancelQueued(new E2ERestartCancelled());
    if (shutdown) return shutdown;
    cleanup = (async () => {
      try {
        if (child?.kill('SIGTERM')) requestedChildSignals.add('SIGTERM');
        await closeOwnedServers();
      } finally {
        cleanupSettled = true;
        removeReusableHandlers();
      }
    })();
    // Retain and observe the original work even if the bounded caller times out.
    void cleanup.catch(recordCleanupFailure);
    shutdown = beforeDeadline(
      cleanup,
      performance.now() + 10_000,
      'E2E resource cleanup exceeded ten seconds'
    ).catch((error: unknown) => {
      recordCleanupFailure(error);
      throw error;
    });
    return shutdown;
  }
  function onSignal(signal: NodeJS.Signals) {
    receivedSignals.add(signal);
    stopped = true;
    terminal.begin();
    if (startupFailure)
      terminal.fail(startupFailure.error, 'E2E startup failed');
    signalShutdown ??= Promise.resolve().then(async () => {
      try {
        await close();
      } catch (error) {
        terminal.fail(error, 'E2E cleanup failed');
      }
      // A previously timed-out public close result does not settle the owned
      // work. Join it under this terminal deadline without restarting cleanup.
      try {
        await cleanup;
      } catch (error) {
        terminal.fail(error, 'E2E cleanup failed');
      }
      reconcileChildSignal();
      return terminal.finish();
    });
  }
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  function requireRunning() {
    if (stopped) throw new E2EStartupCancelled();
  }
  async function acquire<T>(pending: Promise<T>, save: (value: T) => void) {
    const operation = pending.then(save, (error: unknown) => {
      recordStartupFailure(error);
      throw error;
    });
    acquiring = operation;
    try {
      await operation;
    } finally {
      if (acquiring === operation) acquiring = undefined;
    }
    requireRunning();
  }
  function registerServer(server: ViteDevServer) {
    configuration?.ignoreBridge(server);
    let instance = [...instances.values()].find(
      (candidate) => candidate.data?.config === server.config
    );
    if (!instance) {
      vite ??= server;
      const token = {};
      instance = {
        token,
        data: {
          config: server.config,
          close: server.close.bind(server),
          restart: server.restart.bind(server),
        },
        adopted: server.config === vite.config,
        replaced: false,
      };
      instances.set(token, instance);
      observer.register(server.config);
      server.restart = (...args) => requestRestart(token, args);
      server.close = async () => {
        try {
          await close();
          await cleanup;
        } catch (error) {
          recordCleanupFailure(error);
          if (terminal.active) await cleanup?.catch(recordCleanupFailure);
          throw error;
        } finally {
          reconcileChildSignal();
          if (terminal.active) await flushE2EOutput();
        }
      };
    }
    if (server.listen && !listenWrappers.has(server.listen)) {
      const delegate = server.listen;
      const token = instance.token;
      const wrapper: ViteDevServer['listen'] = function (
        this: ViteDevServer,
        ...args
      ) {
        if (instances.get(token)?.data?.config === vite?.config)
          confirmAdoption();
        return delegate.apply(this, args);
      };
      listenWrappers.add(wrapper);
      server.listen = wrapper;
    }
  }
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    database = new PGlite('memory://');
    await acquire(database.waitReady, () => {});
    socket = new PGLiteSocketServer({
      db: database,
      host: '127.0.0.1',
      port: options.databasePort ?? config.port,
      maxConnections: 16,
    });
    await acquire(socket.start(), () => {});
    const databaseUrl = new URL(config.databaseUrl);
    databaseUrl.host = socket.getServerConn();
    Object.assign(process.env, {
      ...config.environment,
      E2E_DATABASE_URL: databaseUrl.href,
      DATABASE_URL: databaseUrl.href,
      DATABASE_MIGRATION_URL: databaseUrl.href,
    });
    options.onDatabaseReady?.(databaseUrl.href);
    for (const script of options.setupScripts ?? setupScripts) {
      requireRunning();
      console.log(`E2E setup: ${script}`);
      requestedChildSignals.clear();
      child = spawn(
        process.execPath,
        [path.resolve('run-jiti.js'), path.resolve(script)],
        {
          stdio: 'inherit',
          env: process.env,
        }
      );
      childResult = new Promise<void>((resolve, reject) => {
        child!.once('error', (error) => {
          recordStartupFailure(error);
          reject(error);
        });
        child!.once('close', (status, signal) => {
          if (status === 0) {
            resolve();
            return;
          }
          const error = signal
            ? new E2ESetupSignal(script, signal)
            : new Error(`E2E setup failed: ${script} (${status})`);
          recordStartupFailure(error);
          reject(error);
        });
      });
      await childResult;
      child = undefined;
      childResult = undefined;
    }
    requireRunning();
    let createServer!: (typeof import('vite'))['createServer'];
    await acquire(import('vite'), (module) => {
      createServer = module.createServer;
    });
    await acquire(
      createOwnedViteConfig(options.viteConfig ?? {}, {
        name: 'e2e-owned-database',
        api: {
          prepare: observer.prepare,
          register: registerServer,
          isFinalClose: () => {
            const intent = closeContext.getStore();
            return (
              intent?.purpose === 'shutdown' &&
              intent.target === currentInstance()?.token
            );
          },
        },
        enforce: 'pre',
        configResolved: { order: 'pre', handler: observer.prepare },
        configureServer: { order: 'pre', handler: registerServer },
        async closeServer({ reason }) {
          observer.markTeardown();
          if (reason === 'close' && terminal.active) await flushE2EOutput();
        },
      }),
      (prepared) => {
        configuration = prepared;
      }
    );
    await acquire(
      restartContext.run(startupContext, () =>
        createServer(configuration!.config)
      ),
      (server) => {
        vite = server;
      }
    );
    await acquire(
      restartContext.run(startupContext, () => vite!.listen()),
      () => {}
    );
    console.log('E2E webserver ready');
    startupSettled = true;
    startupContext.active = false;
    startRestartQueue();
    return { vite: vite!, close, databaseUrl: databaseUrl.href };
  } catch (error) {
    recordStartupFailure(error);
    let cleanupFailure: { error: unknown } | undefined;
    try {
      await close();
    } catch (cleanupError) {
      recordCleanupFailure(cleanupError);
      cleanupFailure = { error: cleanupError };
    }
    reconcileChildSignal();
    startupContext.active = false;
    startupSettled = true;
    removeReusableHandlers();
    if (
      error instanceof E2EStartupCancelled ||
      (error instanceof E2ESetupSignal && isCancelledSignal(error))
    ) {
      if (cleanupFailure) throw cleanupFailure.error;
      return undefined;
    }
    throw error;
  }
}
