import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { InlineConfig, ViteDevServer } from 'vite';

import { beforeDeadline } from '../support/promise-deadline';
import { configureE2EDatabase } from './e2e-database-config';
import { createE2ETerminal, flushE2EOutput } from './e2e-terminal';

const setupScripts = [
  'src/platform/env/client.ts',
  'scripts/validate-server-config.ts',
  'src/modules/kernel/infrastructure/db/migrate-cli.ts',
  'drizzle/seed/index.ts',
  'src/app/build-info/infrastructure/generate-build-info.ts',
] as const;

type OwnedViteInstance = {
  config: ViteDevServer['config'];
  close: () => Promise<void>;
  restart: ViteDevServer['restart'];
  closing?: Promise<void>;
  replaced: boolean;
};

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
  let child: ChildProcess | undefined;
  let childResult: Promise<void> | undefined;
  const requestedChildSignals = new Set<NodeJS.Signals>();
  const receivedSignals = new Set<NodeJS.Signals>();
  const instances: OwnedViteInstance[] = [];
  let restarting: Promise<void> | undefined;
  let queuedRestart: Parameters<ViteDevServer['restart']> | undefined;
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
  function throwCleanupFailures(failures: unknown[]) {
    const unique = [...new Set(failures)];
    if (unique.length === 1) throw unique[0];
    if (unique.length > 1)
      throw new AggregateError(unique, 'E2E owned resource cleanup failed', {
        cause: unique[0],
      });
  }
  function closeInstance(instance: OwnedViteInstance) {
    instance.closing ??= Promise.resolve().then(() => instance.close());
    return instance.closing;
  }
  async function closeInstances(selected: OwnedViteInstance[]) {
    const outcomes = await Promise.allSettled(selected.map(closeInstance));
    return outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : []
    );
  }
  async function restartInstance(
    instance: OwnedViteInstance,
    args: Parameters<ViteDevServer['restart']>
  ) {
    const failures: unknown[] = [];
    try {
      await instance.restart(...args);
    } catch (error) {
      failures.push(error);
    }
    if (vite?.config !== instance.config) {
      // Vite adopted a replacement and already tore down the old resources.
      // Its proxy now targets the replacement: never close that stale alias.
      instance.replaced = true;
    }
    const retirementFailures = await closeInstances(
      instances.filter(
        (candidate) => !candidate.replaced && candidate.config !== vite?.config
      )
    );
    for (const error of retirementFailures) recordCleanupFailure(error);
    failures.push(...retirementFailures);
    throwCleanupFailures(failures);
  }
  function requestRestart(
    instance: OwnedViteInstance,
    args: Parameters<ViteDevServer['restart']>
  ): Promise<void> {
    if (stopped || !startupSettled || instance.config !== vite?.config)
      return Promise.resolve();
    if (restarting) {
      queuedRestart = [!!queuedRestart?.[0] || !!args[0]];
      return restarting;
    }
    const operation = Promise.resolve().then(async () => {
      let next: Parameters<ViteDevServer['restart']> | undefined = args;
      while (next && !stopped) {
        if (queuedRestart) next = [!!next[0] || !!queuedRestart[0]];
        queuedRestart = undefined;
        const active = instances.find(
          (candidate) => candidate.config === vite?.config
        )!;
        await restartInstance(active, next);
        next = queuedRestart;
      }
    });
    const tracked = operation.finally(() => {
      if (restarting === tracked) restarting = undefined;
    });
    restarting = tracked;
    return tracked;
  }
  function closeOwnedServers() {
    serverCleanup ??= (async () => {
      await settleStartupOperation();
      const failures = await closeInstances(
        instances.filter((instance) => !instance.replaced)
      );
      // Every Vite teardown, including its plugin hooks, finishes before the
      // shared database closes. Partial-instance hooks cannot close it early.
      try {
        await closeDatabase();
      } catch (error) {
        failures.push(error);
      }
      throwCleanupFailures(failures);
    })();
    return serverCleanup;
  }
  function close() {
    stopped = true;
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
      createServer({
        ...options.viteConfig,
        plugins: [
          {
            name: 'e2e-owned-database',
            enforce: 'pre',
            configureServer: {
              order: 'pre',
              handler(server) {
                vite ??= server;
                const instance: OwnedViteInstance = {
                  config: server.config,
                  close: server.close.bind(server),
                  restart: server.restart.bind(server),
                  replaced: false,
                };
                instances.push(instance);
                // Incomplete/abandoned instances cannot drive shared restart
                // state. The active owner serializes creation and retirement.
                server.restart = (...args) => requestRestart(instance, args);
                server.close = async () => {
                  try {
                    await close();
                    await cleanup;
                  } catch (error) {
                    recordCleanupFailure(error);
                    // Vite's own SIGTERM handler exits after this public wrapper.
                    // Keep it joined to work still pending after a public timeout.
                    if (terminal.active)
                      await cleanup?.catch(recordCleanupFailure);
                    throw error;
                  } finally {
                    reconcileChildSignal();
                    if (terminal.active) await flushE2EOutput();
                  }
                };
              },
            },
            async closeServer({ reason }) {
              // This hook runs after each server's teardown. It must not await
              // the coordinator (which joins it), or close the shared database.
              if (reason === 'close' && terminal.active) await flushE2EOutput();
            },
          },
          ...(options.viteConfig?.plugins ?? []),
        ],
      }),
      (server) => {
        vite = server;
      }
    );
    await acquire(vite!.listen(), () => {});
    console.log('E2E webserver ready');
    startupSettled = true;
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
