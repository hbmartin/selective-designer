import type { AddressInfo } from 'node:net';
import { startE2EWebserver } from '../server/e2e-webserver';

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

try {
  const owner = await startE2EWebserver({
    databasePort: ports.database ?? 0,
    onDatabaseReady: (databaseUrl) =>
      process.send?.({ type: 'database-ready', databaseUrl }),
    setupScripts: mode.startsWith('failure-')
      ? Array.from({ length: 5 }, (_, index) =>
          index === Number(mode.split('-')[1])
            ? 'tests/support/e2e-webserver-setup.fixture.ts'
            : 'tests/support/e2e-webserver-success.fixture.ts'
        )
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
            if (mode === 'nonzero-status') process.exitCode = 7;
            if (mode === 'lingering' || mode === 'cleanup-failure')
              setInterval(() => {}, 1000); // Deliberately survive Vite close.
            if (mode === 'creating') {
              console.log('Fixture Vite creating');
              await released;
            }
            if (mode === 'startup-cleanup-failure')
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
          closeServer({ reason }) {
            if (reason !== 'close') return;
            console.log('Fixture final close');
            if (mode.endsWith('cleanup-failure'))
              throw new Error('Fixture secondary cleanup failure');
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
      if (message === 'restart')
        void owner.vite
          .restart()
          .then(() => process.send?.({ type: 'restarted' }));
      if (message === 'close')
        void Promise.all([owner.close(), owner.close()]).then(() =>
          process.send?.({ type: 'closed' })
        );
    });
  }
} catch (error) {
  console.error(
    `Fixture startup failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
