import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import {
  runE2EWebserverCommand,
  startE2EWebserver,
} from '../server/e2e-webserver';

const [root, mode = 'ready', requestedPorts = '{}'] = process.argv.slice(3);
if (!root) throw new Error('Fixture root required');
const ports = JSON.parse(requestedPorts) as {
  database?: number;
  http?: number;
};
process.on('SIGINT', () => console.log('Fixture signal received'));
process.on('SIGTERM', () => console.log('Fixture signal received'));
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
      configFile: false,
      envDir: false,
      clearScreen: false,
      server: { host: '127.0.0.1', port: ports.http ?? 0, strictPort: true },
      plugins: [
        {
          name: 'fixture-lifecycle',
          async configureServer(server) {
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
              mode === 'startup-lingering'
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
            if (reason !== 'close') return;
            console.log('Fixture final close');
            if (
              mode.endsWith('cleanup-failure') ||
              mode === 'programmatic-failure'
            )
              throw new Error('Fixture secondary cleanup failure');
            if (mode === 'programmatic-hang') await released;
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
      if (message === 'exit-parent') process.exit(0);
      if (message === 'restart')
        void owner.vite
          .restart()
          .then(() => process.send?.({ type: 'restarted' }));
      if (message === 'close')
        void Promise.all([owner.close(), owner.close()]).then(
          () => process.send?.({ type: 'closed' }),
          () =>
            process.send?.({
              type: 'close-failed',
              exitCode: process.exitCode ?? 'unset',
            })
        );
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
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
