import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { ViteDevServer } from 'vite';
import { waitForE2EFixtureAuthorization } from './e2e-fixture-authorization';

await waitForE2EFixtureAuthorization();
const { runE2EWebserverCommand, startE2EWebserver } =
  await import('../server/e2e-webserver');

const [root, mode = 'ready', requestedPorts = '{}'] = process.argv.slice(3);
if (!root) throw new Error('Fixture root required');
const ports = JSON.parse(requestedPorts) as {
  database?: number;
  http?: number;
};
if (
  !mode.startsWith('final-flush') &&
  mode !== 'programmatic-startup-timeout'
) {
  process.on('SIGINT', () => console.log('Fixture signal received'));
  process.on('SIGTERM', () => console.log('Fixture signal received'));
}
const servers: ViteDevServer[] = [];
const watchers: { closed: boolean }[] = [];
let isFinalClose = () => false;
let instancesClosed = 0;
let restartFailures =
  mode === 'restart-fail' ? 1 : mode === 'restart-recover' ? 2 : 0;
const heldOutput: (() => void)[] = [];
let emptyWrites = 0;
let outputReleased = false;
if (mode.startsWith('final-flush')) {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = ((...args: Parameters<typeof stream.write>) => {
      if (args[0] === '' && ++emptyWrites > 2 && !outputReleased) {
        heldOutput.push(() => write(...args));
        process.send?.({ type: 'flush-held' });
        return true;
      }
      return write(...args);
    }) as typeof stream.write;
  }
}
const released = new Promise<void>((resolve) =>
  process.on('message', (message: unknown) => {
    if (message === 'release') resolve();
  })
);
const cleanupReleased = new Promise<void>((resolve) => {
  process.on('message', (message: unknown) => {
    if (message === 'finish-cleanup') resolve();
  });
});

try {
  if (mode === 'config-plugin-failure')
    await writeFile(
      path.join(root, 'vite.config.mjs'),
      `export default { plugins: [{ name: 'early-config-file-plugin', enforce: 'pre', configureServer: { order: 'pre', handler(server) { const close = server.watcher.close.bind(server.watcher); server.watcher.close = async () => { await close(); process.send?.({ type: 'early-watcher-closed' }); }; throw new Error('Fixture early config plugin failure'); } } }] };`
    );
  const start = mode.startsWith('programmatic')
    ? startE2EWebserver
    : runE2EWebserverCommand;
  const owner = await start({
    databasePort: ports.database ?? 0,
    onDatabaseReady: (databaseUrl) =>
      process.send?.({ type: 'database-ready', databaseUrl }),
    setupScripts: mode.startsWith('failure-')
      ? Array.from({ length: 5 }, (_, index) =>
          index === Number(mode.split('-')[1])
            ? 'tests/support/e2e-webserver-setup.fixture.ts'
            : 'tests/support/e2e-webserver-success.fixture.ts'
        )
      : mode === 'setup-nonzero-on-stop'
        ? ['tests/support/e2e-webserver-nonzero.fixture.ts']
        : mode === 'waiting'
          ? ['tests/support/e2e-webserver-setup.fixture.ts']
          : [],
    viteConfig: {
      root,
      configFile:
        mode === 'config-plugin-failure'
          ? path.join(root, 'vite.config.mjs')
          : false,
      envDir: mode.startsWith('restart-') ? undefined : false,
      clearScreen: false,
      server: { host: '127.0.0.1', port: ports.http ?? 0, strictPort: true },
      plugins: [
        {
          name: 'fixture-lifecycle',
          async configureServer(server) {
            const api = server.config.plugins.find(
              (plugin) => plugin.name === 'e2e-owned-database'
            )?.api;
            isFinalClose = () => !!api?.isFinalClose();
            servers.push(server);
            const watcher = { closed: false };
            watchers.push(watcher);
            const closeWatcher = server.watcher.close.bind(server.watcher);
            server.watcher.close = async () => {
              await closeWatcher();
              watcher.closed = true;
            };
            if (servers.length > 1 && restartFailures > 0) {
              restartFailures--;
              throw new Error('Fixture controlled restart failure');
            }
            if (mode === 'nonzero-status' || mode.startsWith('programmatic'))
              process.exitCode = 7;
            if (mode.includes('lingering') || mode === 'cleanup-failure')
              setInterval(() => {}, 1000); // Deliberately survive Vite close.
            if (mode === 'creating') {
              console.log('Fixture Vite creating');
              await released;
            }
            if (mode === 'race-creation') {
              process.send?.({ type: 'failure-gate' });
              await released;
              throw new Error('Fixture genuine creation failure');
            }
            if (mode === 'race-listening') {
              server.listen = async () => {
                process.send?.({ type: 'failure-gate' });
                await released;
                throw new Error('Fixture genuine listening failure');
              };
            }
            if (
              mode === 'startup-cleanup-failure' ||
              mode === 'startup-lingering' ||
              mode === 'programmatic-startup-timeout'
            )
              server.listen = async () => {
                throw new Error('Fixture primary startup failure');
              };
            if (mode.startsWith('listening')) {
              const listen = server.listen.bind(server);
              server.listen = async (...args) => {
                await listen(...args);
                process.send?.({
                  type: 'listening',
                  httpPort: (server.httpServer!.address() as AddressInfo).port,
                });
                console.log('Fixture Vite listening');
                await released;
                return server;
              };
            }
          },
          async closeServer({ reason }) {
            instancesClosed++;
            if (reason !== 'close' || !isFinalClose()) return;
            console.log('Fixture final close');
            if (
              mode.endsWith('cleanup-failure') ||
              mode === 'programmatic-failure'
            )
              throw new Error('Fixture secondary cleanup failure');
            if (
              mode === 'programmatic-hang' ||
              mode === 'programmatic-startup-timeout'
            )
              await released;
            if (mode.startsWith('race-')) {
              process.send?.({ type: 'cleanup-gate' });
              await cleanupReleased;
            }
          },
        },
      ],
    },
  });
  if (owner) {
    process.send?.({
      type: 'ready',
      httpPort: (owner.vite.httpServer!.address() as AddressInfo).port,
    });
    process.on('message', (message: unknown) => {
      if (message === 'start-pipe-holder') {
        const holder = spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          {
            stdio: ['ignore', 'inherit', 'inherit'],
          }
        );
        holder.once('error', (error) => {
          throw error;
        });
        process.send?.({ type: 'pipe-holder', pid: holder.pid });
      }
      if (message === 'inspect-instances')
        process.send?.({
          type: 'instances',
          instances: servers.length,
          instancesClosed,
          watchersOpen: watchers.filter((watcher) => !watcher.closed).length,
          sigtermHandlers: process.listenerCount('SIGTERM'),
        });
      if (message === 'abandoned-env-change') {
        // Exercise retained generation callbacks, rather than a closed watcher.
        void Promise.all(
          servers
            .filter((candidate) => candidate.config !== owner.vite.config)
            .map((server) => server.restart())
        ).then(() => process.send?.({ type: 'abandoned-change-delivered' }));
      }
      if (message === 'exit-parent') process.exit(0);
      if (message === 'restart')
        void owner.vite
          .restart()
          .then(() => process.send?.({ type: 'restarted' }));
      if (message === 'close')
        void Promise.all([owner.close(), owner.close()]).then(
          () =>
            process.send?.({
              type: 'closed',
              watchersClosed: watchers.every((watcher) => watcher.closed),
              instances: servers.length,
            }),
          () =>
            process.send?.({
              type: 'close-failed',
              exitCode: process.exitCode ?? 'unset',
            })
        );
      if (message === 'release-flush') {
        outputReleased = true;
        for (const write of heldOutput.splice(0)) write();
      }
      if (typeof message === 'string' && message.startsWith('ping'))
        process.send?.({
          type: message.replace('ping', 'pong'),
          exitCode: process.exitCode ?? 'unset',
        });
    });
  }
} catch (error) {
  console.error(
    `Fixture startup failed: ${error instanceof Error ? error.message : String(error)}`
  );
  if (mode === 'programmatic-startup-timeout') {
    process.send?.({
      type: 'startup-failed',
      exitCode: process.exitCode ?? 'unset',
    });
    process.on('message', (message: unknown) => {
      if (message === 'ping-after-startup-timeout')
        process.send?.({
          type: 'pong-after-startup-timeout',
          exitCode: process.exitCode ?? 'unset',
        });
    });
  } else {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}
