import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { InlineConfig, ViteDevServer } from 'vite';

import { configureE2EDatabase } from './e2e-database-config';

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
};

/** Own the disposable database and HTTP listener for one Playwright invocation. */
export async function startE2EWebserver(options: E2EWebserverOptions = {}) {
  const config = configureE2EDatabase();
  let database: PGlite | undefined;
  let socket: PGLiteSocketServer | undefined;
  let vite: ViteDevServer | undefined;
  let child: ChildProcess | undefined;
  let childResult: Promise<void> | undefined;
  let acquiring: Promise<unknown> | undefined;
  let stopped = false;
  let databaseCleanup: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;

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
  function close() {
    stopped = true;
    shutdown ??= (async () => {
      const deadline = setTimeout(() => {
        child?.kill('SIGKILL');
        console.error('E2E webserver shutdown exceeded ten seconds');
        process.exit(1);
      }, 10_000);
      deadline.unref();
      try {
        child?.kill('SIGTERM');
        await Promise.allSettled([acquiring, childResult]);
        try {
          await vite?.close();
        } finally {
          await closeDatabase();
        }
      } finally {
        clearTimeout(deadline);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
    })();
    return shutdown;
  }
  function onSignal() {
    void close().catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : 'E2E shutdown failed'
      );
      process.exitCode = 1;
    });
  }
  async function acquire<T>(pending: Promise<T>, save: (value: T) => void) {
    acquiring = pending.then(save);
    await acquiring;
    acquiring = undefined;
    if (stopped) throw new Error('E2E startup cancelled');
  }
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    database = new PGlite('memory://');
    await acquire(database.waitReady, () => {});
    socket = new PGLiteSocketServer({
      db: database,
      host: '127.0.0.1',
      port: config.port,
      maxConnections: 16,
    });
    await acquire(socket.start(), () => {});
    for (const script of options.setupScripts ?? setupScripts) {
      if (stopped) throw new Error('E2E startup cancelled');
      console.log(`E2E setup: ${script}`);
      child = spawn(
        process.execPath,
        [path.resolve('run-jiti.js'), path.resolve(script)],
        {
          stdio: 'inherit',
          env: process.env,
        }
      );
      childResult = new Promise<void>((resolve, reject) => {
        child!.once('error', reject);
        child!.once('close', (status, signal) => {
          if (status === 0) resolve();
          else
            reject(
              new Error(`E2E setup failed: ${script} (${signal ?? status})`)
            );
        });
      });
      await childResult;
      child = undefined;
      childResult = undefined;
    }
    if (stopped) throw new Error('E2E startup cancelled');
    const { createServer } = await import('vite');
    if (stopped) throw new Error('E2E startup cancelled');
    await acquire(
      createServer({
        ...options.viteConfig,
        plugins: [
          ...(options.viteConfig?.plugins ?? []),
          {
            name: 'e2e-owned-database',
            async closeServer({ reason }) {
              if (reason === 'close') await closeDatabase();
            },
          },
        ],
      }),
      (server) => {
        vite = server;
      }
    );
    await acquire(vite!.listen(), () => {});
    console.log('E2E webserver ready');
    return { vite: vite!, close };
  } catch (error) {
    const cancelled = stopped;
    await close();
    if (!cancelled) throw error;
    return undefined;
  }
}
