import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  createServer,
  DevEnvironment,
  type InlineConfig,
  type ResolvedConfig,
  type ViteDevServer,
} from 'vite';
import { createOwnedViteConfig } from '@tests/server/vite-owned-config';
import { createViteResourceObserver } from '@tests/server/vite-resource-observer';

async function harness(
  run: (h: {
    root: string;
    observer: ReturnType<typeof createViteResourceObserver>;
    captured: ViteDevServer[];
    emergency: (() => Promise<unknown>)[];
    create: (config: InlineConfig) => Promise<ViteDevServer>;
  }) => Promise<void>
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'vite-owned-integration-'))
  );
  const observer = createViteResourceObserver();
  const captured: ViteDevServer[] = [];
  const closers: { config: ResolvedConfig; close: () => Promise<void> }[] = [];
  const emergency: (() => Promise<unknown>)[] = [];
  const bridges: Awaited<ReturnType<typeof createOwnedViteConfig>>[] = [];
  try {
    await writeFile(path.join(root, 'index.html'), '<h1>Owned Vite</h1>');
    await run({
      root,
      observer,
      captured,
      emergency,
      async create(options) {
        let prepared!: Awaited<ReturnType<typeof createOwnedViteConfig>>;
        function register(server: ViteDevServer) {
          prepared.ignoreBridge(server);
          if (captured.includes(server)) return;
          observer.register(server.config);
          captured.push(server);
          closers.push({
            config: server.config,
            close: server.close.bind(server),
          });
          const restart = server.restart.bind(server);
          server.restart = async (...args) => {
            await prepared.refresh();
            return observer.run(server.config, () => restart(...args));
          };
        }
        prepared = await createOwnedViteConfig(
          {
            root,
            envDir: false,
            configFile: false,
            server: { host: '127.0.0.1', port: 0, strictPort: true },
            ...options,
          },
          {
            name: 'e2e-owned-database',
            api: {
              prepare: observer.prepare,
              register,
            },
            configResolved: observer.prepare,
            configureServer: register,
          }
        );
        bridges.push(prepared);
        return createServer(prepared.config);
      },
    });
  } finally {
    await Promise.allSettled(
      closers.map((record) => observer.run(record.config, record.close))
    );
    await Promise.allSettled(emergency.map((close) => close()));
    await observer.settleAll();
    await Promise.all(bridges.map((bridge) => bridge.remove()));
    await rm(root, { recursive: true, force: true });
  }
}
it('owns a config-file plugin with both pre priorities before its failure', async () => {
  await harness(async ({ root, create, captured }) => {
    const file = path.join(root, 'application.config.mjs');
    await writeFile(
      file,
      `export default {plugins:[{name:'first-app-plugin',enforce:'pre',configureServer:{order:'pre',handler(){throw new Error('Early app failure');}}}]};`
    );
    await expect(create({ configFile: file })).rejects.toThrow(
      'Early app failure'
    );
    expect(captured).toHaveLength(1);
  });
});
it('owns the watcher before an environment factory rejects and drains peer init', async () => {
  await harness(async ({ observer, create, captured }) => {
    const failure = new Error('Factory failed');
    let watcher!: { close(): Promise<void> };
    const closed = vi.fn();
    await expect(
      create({
        environments: {
          client: {
            dev: {
              createEnvironment(name, config) {
                const env = new DevEnvironment(name, config, { hot: false });
                const init = env.init.bind(env);
                env.init = (input) => {
                  watcher = input!.watcher!;
                  const close = watcher.close.bind(watcher);
                  watcher.close = async () => {
                    await close();
                    closed();
                  };
                  return init(input);
                };
                return env;
              },
            },
          },
          ssr: {
            dev: {
              createEnvironment() {
                throw failure;
              },
            },
          },
        },
      })
    ).rejects.toBe(failure);
    expect(captured).toHaveLength(0);
    expect(await observer.settleAll()).toEqual([]);
    expect(closed).toHaveBeenCalledOnce();
  });
});
it('preserves the original error when every factory rejects', async () => {
  await harness(async ({ create, observer, captured }) => {
    const failure = new Error('Every factory failed');
    const createEnvironment = () => {
      throw failure;
    };
    await expect(
      create({
        environments: {
          client: { dev: { createEnvironment } },
          ssr: { dev: { createEnvironment } },
        },
      })
    ).rejects.toBe(failure);
    expect(captured).toHaveLength(0);
    expect(await observer.settleAll()).toEqual([]);
  });
});
it('surfaces watcher rejection discarded by native Vite close', async () => {
  await harness(async ({ create, observer, emergency }) => {
    const failure = new Error('Native watcher failure');
    const server = await create({
      plugins: [
        {
          name: 'faulty-watcher',
          configureServer(server) {
            emergency.push(server.watcher.close.bind(server.watcher));
            server.watcher.close = async () => {
              throw failure;
            };
          },
        },
      ],
    });
    await observer.run(server.config, () => server.close());
    expect(await observer.settle(server.config)).toEqual([failure]);
  });
});
it('joins all sibling close hooks after native Vite rejects early', async () => {
  await harness(async ({ create, observer }) => {
    const first = new Error('First hook failed');
    const second = new Error('Late sibling failed');
    let reject!: (error: Error) => void;
    const delayed = new Promise<void>((_resolve, no) => {
      reject = no;
    });
    let entered!: () => void;
    const siblingStarted = new Promise<void>((yes) => {
      entered = yes;
    });
    const server = await create({
      plugins: [
        {
          name: 'first-close',
          closeServer() {
            throw first;
          },
        },
        {
          name: 'delayed-close',
          closeServer() {
            entered();
            return delayed;
          },
        },
      ],
    });
    await expect(
      observer.run(server.config, () => server.close())
    ).rejects.toBe(first);
    await siblingStarted;
    let settled = false;
    const draining = observer.settle(server.config).then((errors) => {
      settled = true;
      return errors;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    reject(second);
    expect(await draining).toEqual([first, second]);
  });
});
it('retains a transient outer failure without replaying its wrapper', async () => {
  await harness(async ({ create, observer, emergency }) => {
    const failure = Object.assign(new Error('Watcher temporarily busy'), {
      code: 'EBUSY',
    });
    const server = await create({
      plugins: [
        {
          name: 'transient-watcher',
          configureServer(server) {
            const close = server.watcher.close.bind(server.watcher);
            emergency.push(close);
            let attempts = 0;
            server.watcher.close = async () => {
              if (++attempts === 1) throw failure;
              await close();
            };
          },
        },
      ],
    });
    await observer.run(server.config, () => server.close());
    expect(await observer.settle(server.config)).toEqual([failure]);
  });
});

it('observes a close hook installed during a later configResolved callback', async () => {
  await harness(async ({ create, observer }) => {
    const closed = vi.fn(async () => {});
    const plugin: import('vite').Plugin = {
      name: 'late-hook',
      configResolved() {
        plugin.closeServer = closed;
      },
    };
    const server = await create({ plugins: [plugin] });
    await observer.run(server.config, () => server.close());
    expect(await observer.settle(server.config)).toEqual([]);
    expect(closed).toHaveBeenCalledOnce();
  });
});
it.each(['js', 'mjs', 'ts', 'cjs', 'mts', 'cts'])(
  'discovers the native default %s config',
  async (extension) => {
    await harness(async ({ root, create }) => {
      const source =
        extension === 'cjs'
          ? 'module.exports = {base:"/selected/"};'
          : 'export default {base:"/selected/"};';
      await writeFile(path.join(root, `vite.config.${extension}`), source);
      const server = await create({ configFile: undefined });
      expect(server.config.base).toBe('/selected/');
    });
  }
);
it('preserves native config precedence and the no-config case', async () => {
  await harness(async ({ root, create }) => {
    expect(
      (await create({ configFile: undefined })).config.inlineConfig.configFile
    ).toMatch(/e2e-vite-config-/);
    await writeFile(
      path.join(root, 'vite.config.js'),
      'export default {base:"/first/"};'
    );
    await writeFile(
      path.join(root, 'vite.config.ts'),
      'export default {base:"/second/"};'
    );
    expect((await create({ configFile: undefined })).config.base).toBe(
      '/first/'
    );
  });
});
it('drains exposed parts after failed initialization without a false container error', async () => {
  await harness(async ({ create, observer }) => {
    const failure = new Error('Original init failure');
    const hotClose = vi.fn(async () => {});
    await expect(
      create({
        environments: {
          client: {
            dev: {
              createEnvironment(name, config) {
                const env = new DevEnvironment(name, config, { hot: false });
                env.hot.close = hotClose;
                env.init = async () => {
                  throw failure;
                };
                return env;
              },
            },
          },
        },
      })
    ).rejects.toBe(failure);
    expect(await observer.settleAll()).toEqual([]);
    expect(hotClose).toHaveBeenCalledOnce();
  });
});
it('retains genuine custom environment cleanup failures after failed init', async () => {
  await harness(async ({ create, observer }) => {
    const failure = new Error('Original init failure');
    const cleanup = new Error('Custom cleanup failure');
    await expect(
      create({
        environments: {
          client: {
            dev: {
              createEnvironment(name, config) {
                const env = new DevEnvironment(name, config, { hot: false });
                env.init = async () => {
                  throw failure;
                };
                env.close = async () => {
                  throw cleanup;
                };
                return env;
              },
            },
          },
        },
      })
    ).rejects.toBe(failure);
    expect(await observer.settleAll()).toEqual([cleanup]);
  });
});

it.each(['own', 'inherited'] as const)(
  'keeps %s readonly synchronous close hooks from suppressing independent cleanup',
  async (placement) => {
    await harness(async ({ create, observer }) => {
      const failure = new Error('Readonly synchronous failure');
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const receivers: unknown[] = [];
      const hook = {
        order: 'pre' as const,
        handler: function () {
          receivers.push(this);
          throw failure;
        },
      };
      const frozen: import('vite').Plugin =
        placement === 'own'
          ? Object.freeze({ name: 'readonly-hook', closeServer: hook })
          : Object.assign(
              Object.create(
                Object.defineProperty({}, 'closeServer', {
                  value: hook,
                  writable: false,
                })
              ),
              { name: 'readonly-inherited-hook' }
            );

      const server = await create({
        plugins: [
          frozen,
          {
            name: 'independent-hook',
            closeServer() {
              receivers.push(this);
              entered.resolve();
              return gate.promise;
            },
          },
        ],
      });
      await expect(
        observer.run(server.config, () => server.close())
      ).rejects.toBe(failure);
      await entered.promise;
      let settled = false;
      const draining = observer.settle(server.config).then((errors) => {
        settled = true;
        return errors;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(receivers).toHaveLength(2);
      expect(receivers[0]).toBe(receivers[1]);
      gate.resolve();
      expect(await draining).toEqual([failure]);
      expect(hook.order).toBe('pre');
    });
  }
);
it('rediscovers defaults across addition, precedence changes, deletion and no-config restart', async () => {
  await harness(async ({ root, create }) => {
    const server = await create({
      configFile: undefined,
      server: { host: '127.0.0.1', port: 0, strictPort: true, watch: null },
    });
    const first = path.join(root, 'vite.config.mjs');
    const higher = path.join(root, 'vite.config.js');
    await writeFile(first, 'export default {base:"/mjs/"};');
    await server.restart();
    expect(server.config.base).toBe('/mjs/');
    await writeFile(higher, 'export default {base:"/js/"};');
    await server.restart();
    expect(server.config.base).toBe('/js/');
    await rm(higher);
    await server.restart();
    expect(server.config.base).toBe('/mjs/');
    await rm(first);
    await server.restart();
    expect(server.config.base).toBe('/');
    expect(server.config.server.watch).toBeNull();
  });
});
it('preserves native config dependency watching without bridge-induced duplicate restarts', async () => {
  await harness(async ({ root, create, captured }) => {
    const dependency = path.join(root, 'settings.mjs');
    await writeFile(dependency, 'export const base="/before/";');
    await writeFile(
      path.join(root, 'vite.config.mjs'),
      `import {base} from './settings.mjs';export default {base};`
    );
    const server = await create({ configFile: undefined });
    expect(server.config.configFileDependencies).toContain(dependency);
    await vi.waitFor(() =>
      expect(server.watcher.getWatched()[root]).toContain('settings.mjs')
    );
    await writeFile(dependency, 'export const base="/after/";');
    await vi.waitFor(() => expect(server.config.base).toBe('/after/'));
    await writeFile(
      path.join(root, 'vite.config.js'),
      'export default {base:"/higher/"};'
    );
    await server.restart();
    expect(server.config.base).toBe('/higher/');
    const generations = captured.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(captured).toHaveLength(generations);
  });
});
it('preserves source-disabled watchers and explicit false configuration', async () => {
  await harness(async ({ root, create }) => {
    await writeFile(
      path.join(root, 'vite.config.mjs'),
      'export default {base:"/source/",server:{watch:null}};'
    );
    const server = await create({ configFile: undefined });
    expect(server.config.server.watch).toBeNull();
    const disabled = await create({ configFile: false });
    expect(disabled.config.base).toBe('/');
    expect(disabled.config.configFile).toBeUndefined();
  });
});

it('does not replay actual failed candidate lifecycle requests and preserves later recovery', async () => {
  const { startE2EWebserver } = await import('@tests/server/e2e-webserver');
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'vite-candidate-request-'))
  );
  const previous = { ...process.env };
  let owner: Awaited<ReturnType<typeof startE2EWebserver>>;
  let generations = 0;
  try {
    process.env.E2E_DATABASE_URL = '';
    owner = await startE2EWebserver({
      setupScripts: [],
      databasePort: 0,
      viteConfig: {
        root,
        configFile: false,
        envDir: false,
        server: { host: '127.0.0.1', port: 0, strictPort: true },
        optimizeDeps: { noDiscovery: true },
        plugins: [
          {
            name: 'failed-incoming',
            async configureServer(server) {
              generations++;
              if (generations === 2) {
                await server.restart(true);
                throw new Error('Incoming candidate rejected');
              }
            },
          },
        ],
      },
    });
    await owner!.vite.restart();
    expect(generations).toBe(2);
    await owner!.vite.restart();
    expect(generations).toBe(3);
  } finally {
    await owner?.close();
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
});
it('preserves inline watcher ignore functions and late hooks on writable facades', async () => {
  await harness(async ({ create, observer }) => {
    const ignored = () => false;
    const closed = vi.fn(async () => {});
    const plugin: import('vite').Plugin = {
      name: 'late-facade-hook',
      configResolved() {
        plugin.closeServer = closed;
      },
    };
    Object.defineProperty(plugin, 'configureServer', {
      value: () => {},
      writable: false,
    });
    const server = await create({
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
        watch: { ignored },
      },
      plugins: [plugin],
    });
    expect(server.config.server.watch?.ignored).toBe(ignored);
    await observer.run(server.config, () => server.close());
    expect(await observer.settle(server.config)).toEqual([]);
    expect(closed).toHaveBeenCalledOnce();
  });
});
