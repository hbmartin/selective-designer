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
  const serverClosures = new Set<() => Promise<void>>();
  let serverCleanup: Promise<void> | undefined;
  let restarting: Promise<void> | undefined;
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
    if (terminal.active || !startupSettled) return;
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
  function closeOwnedServers() {
    serverCleanup ??= (async () => {
      await settleStartupOperation();
      const outcomes = await Promise.allSettled(
        [...serverClosures].map((closeServer) =>
          Promise.resolve().then(closeServer)
        )
      );
      // Successful restarts can make earlier callbacks join the current Vite
      // close promise. Retain each original failure once across those aliases.
      const failures = [
        ...new Set(
          outcomes.flatMap((outcome) =>
            outcome.status === 'rejected' ? [outcome.reason as unknown] : []
          )
        ),
      ];
      try {
        await closeDatabase();
      } catch (error) {
        if (!failures.includes(error)) failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          'E2E owned resource cleanup failed',
          {
            cause: failures[0],
          }
        );
    })();
    return serverCleanup;
  }
  function close() {
    stopped = true;
    if (shutdown) return shutdown;
    const cleanup = (async () => {
      try {
        if (child?.kill('SIGTERM')) requestedChildSignals.add('SIGTERM');
        await closeOwnedServers();
      } finally {
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
  async function finalViteClose() {
    await settleStartupOperation();
    try {
      await closeDatabase();
    } catch (error) {
      recordCleanupFailure(error);
      // The shared coordinator returns this database failure once, after every
      // server has closed. Hooks report it before Vite's native signal exit.
    } finally {
      if (terminal.active) await flushE2EOutput();
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
      createServer({
        ...options.viteConfig,
        plugins: [
          {
            name: 'e2e-owned-database',
            configureServer(server) {
              // Retain a public handle even when a later creation hook fails.
              vite ??= server;
              const closeVite = server.close.bind(server);
              serverClosures.add(closeVite);
              const restartVite = server.restart.bind(server);
              server.restart = (...args) => {
                if (stopped) return Promise.reject(new E2EStartupCancelled());
                const operation = restartVite(...args);
                const tracked = operation.finally(() => {
                  if (restarting === tracked) restarting = undefined;
                });
                restarting = tracked;
                return tracked;
              };
              server.close = async () => {
                try {
                  await close();
                } catch (error) {
                  recordCleanupFailure(error);
                  throw error;
                } finally {
                  reconcileChildSignal();
                  if (terminal.active) await flushE2EOutput();
                }
              };
            },
            async closeServer({ reason }) {
              if (reason === 'close') await finalViteClose();
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
