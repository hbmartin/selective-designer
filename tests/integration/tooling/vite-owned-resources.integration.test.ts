import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'vite-owned-integration-'));
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
        const prepared = await createOwnedViteConfig(
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
              register(server: ViteDevServer) {
                if (captured.includes(server)) return;
                observer.register(server.config);
                captured.push(server);
                closers.push({
                  config: server.config,
                  close: server.close.bind(server),
                });
              },
            },
            configResolved: observer.prepare,
            configureServer(server) {
              if (captured.includes(server)) return;
              observer.register(server.config);
              captured.push(server);
              closers.push({
                config: server.config,
                close: server.close.bind(server),
              });
            },
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
    ).toBe(false);
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
