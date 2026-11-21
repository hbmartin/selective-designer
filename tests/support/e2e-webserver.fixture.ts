import { startE2EWebserver } from '../server/e2e-webserver';
const [root, mode] = process.argv.slice(3);
if (!root) throw new Error('Fixture root required');
process.on('SIGINT', () => console.log('Fixture signal received'));
process.on('SIGTERM', () => console.log('Fixture signal received'));
const released = new Promise<void>((resolve) =>
  process.on('message', (message: unknown) => {
    if (message === 'release') resolve();
  })
);
const owner = await startE2EWebserver({
  setupScripts: mode?.startsWith('failure-')
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
    server: { host: '127.0.0.1', port: 3000, strictPort: true },
    plugins: [
      {
        name: 'fixture-ipc',
        async configureServer(server) {
          if (mode === 'creating') {
            console.log('Fixture Vite creating');
            await released;
          }
          if (mode === 'listening') {
            const listen = server.listen.bind(server);
            server.listen = async (...args) => {
              await listen(...args);
              console.log('Fixture Vite listening');
              await released;
              return server;
            };
          }
        },
        closeServer({ reason }) {
          if (reason === 'close' && process.connected) process.disconnect();
        },
      },
    ],
  },
});
if (owner) {
  process.send?.({ type: 'ready' });
  process.on('message', (message: unknown) => {
    if (message === 'restart')
      void owner.vite
        .restart()
        .then(() => process.send?.({ type: 'restarted' }));
  });
}

if (!owner && process.connected) process.disconnect();
