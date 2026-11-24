import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  createServer,
  DevEnvironment,
  createLogger,
  type Logger,
  type InlineConfig,
  type ResolvedConfig,
  type ViteDevServer,
} from 'vite';
import { createOwnedViteConfig } from '@tests/server/vite-owned-config';
import { createViteResourceObserver } from '@tests/server/vite-resource-observer';

async function withVerificationCleanup(
  run: () => Promise<void>,
  actions: (() => unknown)[]
) {
  const failures: unknown[] = [];
  try {
    await run();
  } catch (error) {
    failures.push(error);
  }
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      failures[0] instanceof Error ? failures[0].message : String(failures[0]),
      { cause: failures[0] }
    );
}

async function harness(
  run: (h: {
    root: string;
    observer: ReturnType<typeof createViteResourceObserver>;
    captured: ViteDevServer[];
    emergency: (() => Promise<unknown>)[];
    create: (
      config: InlineConfig,
      decorateLogger?: (logger: Logger) => Logger
    ) => Promise<ViteDevServer>;
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
      async create(options, decorateLogger) {
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
          },
          decorateLogger
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
it('drains exposed parts after failed initialization and retains the secondary native close error', async () => {
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
    expect(await observer.settleAll()).toEqual([
      expect.objectContaining({
        message: 'client environment.pluginContainer called before initialized',
      }),
    ]);
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
    const generations = captured.length;
    await server.restart();
    expect(server.config.base).toBe('/higher/');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(captured).toHaveLength(generations + 1);
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
  await withVerificationCleanup(async () => {
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
  }, [
    () => owner?.close(),
    () => {
      for (const key of Object.keys(process.env))
        if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    },
    () => rm(root, { recursive: true, force: true }),
  ]);
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

it.each([false, true])(
  'drains failed Runnable SSR initialization while retaining secondary close errors; custom=%s',
  async (custom) => {
    const { createRunnableDevEnvironment } = await import('vite');
    await harness(async ({ create, observer }) => {
      const original = new Error('SSR initialization rejected');
      const secondary = new Error('Custom subclass cleanup rejected');
      const hot = vi.fn(async () => {});
      const optimizer = vi.fn(async () => {});
      const closed = vi.fn();
      await expect(
        create({
          environments: {
            ssr: {
              dev: {
                createEnvironment(name, config) {
                  const environment = createRunnableDevEnvironment(
                    name,
                    config
                  );
                  const close = environment.close.bind(environment);
                  environment.hot.close = hot;
                  environment.depsOptimizer = { close: optimizer } as never;
                  environment.init = async () => {
                    throw original;
                  };
                  environment.close = async () => {
                    try {
                      if (custom) throw secondary;
                      await close();
                    } finally {
                      closed();
                    }
                  };
                  return environment;
                },
              },
            },
          },
        })
      ).rejects.toBe(original);
      const errors = await observer.settleAll();
      expect(errors).toEqual([
        custom
          ? secondary
          : expect.objectContaining({
              message:
                'ssr environment.pluginContainer called before initialized',
            }),
      ]);
      expect(closed).toHaveBeenCalledOnce();
      expect(hot).toHaveBeenCalledOnce();
      expect(optimizer).toHaveBeenCalledOnce();
    });
  }
);

it('keeps a retained live SSR environment and websocket open after watcher closure and failed restart', async () => {
  await harness(async ({ create, observer, root }) => {
    await writeFile(path.join(root, 'probe.js'), 'export const value = 42;');
    let generation = 0;
    const server = await create({
      plugins: [
        {
          name: 'failed-replacement',
          configureServer() {
            if (++generation === 2)
              throw new Error('Expected failed incoming generation');
          },
        },
      ],
    });
    await server.listen();
    const environment = server.environments.ssr!;
    const envClose = environment.close.bind(environment);
    const envClosed = vi.fn(async () => envClose());
    environment.close = envClosed;
    const wsClose = server.ws.close.bind(server.ws);
    const wsClosed = vi.fn(async () => wsClose());
    server.ws.close = wsClosed;
    await server.watcher.close();
    await server.restart();
    expect(await observer.settleStarted(server.config)).toEqual([]);
    expect(envClosed).not.toHaveBeenCalled();
    expect(wsClosed).not.toHaveBeenCalled();
    expect((await environment.transformRequest('/probe.js'))?.code).toContain(
      '42'
    );
  });
});

it('runs non-lifecycle hooks installed later on a read-only plugin facade', async () => {
  await harness(async ({ create, root }) => {
    await writeFile(
      path.join(root, 'late.js'),
      'export const value = "before";'
    );
    const api = {};
    const transform = vi.fn((code: string, id: string) =>
      id.endsWith('/late.js') ? code.replace('before', 'after') : undefined
    );
    const plugin: import('vite').Plugin = {
      name: 'late-transform',
      configResolved() {
        plugin.transform = transform;
      },
    };
    Object.defineProperty(plugin, 'configureServer', {
      value: () => {},
      writable: false,
    });
    Object.defineProperty(plugin, 'api', {
      enumerable: true,
      get() {
        expect(this).toBe(plugin);
        return api;
      },
    });
    const server = await create({ plugins: [plugin] });
    expect(
      server.config.plugins.find((candidate) => candidate.name === plugin.name)
        ?.api
    ).toBe(api);
    expect((await server.transformRequest('/late.js'))?.code).toContain(
      'after'
    );
    expect(transform).toHaveBeenCalled();
  });
});

it('restores environment and removes the verification root after close and assertion failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verification-cleanup-'));
  const previous = process.env.TEST_E2E_VERIFICATION_CLEANUP;
  const assertion = new Error('Primary verification assertion');
  const cleanup = new Error('Owner close rejected');
  await expect(
    withVerificationCleanup(async () => {
      process.env.TEST_E2E_VERIFICATION_CLEANUP = 'changed';
      throw assertion;
    }, [
      () => {
        throw cleanup;
      },
      () => {
        if (previous === undefined)
          delete process.env.TEST_E2E_VERIFICATION_CLEANUP;
        else process.env.TEST_E2E_VERIFICATION_CLEANUP = previous;
      },
      () => rm(root, { recursive: true, force: true }),
    ])
  ).rejects.toMatchObject({ cause: assertion, errors: [assertion, cleanup] });
  expect(process.env.TEST_E2E_VERIFICATION_CLEANUP).toBe(previous);
  const { access } = await import('node:fs/promises');
  await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('decorates the final application-selected logger while forwarding its live state', async () => {
  const { createE2ERestartCancellation } =
    await import('@tests/server/e2e-restart-cancellation');
  await harness(async ({ create, root }) => {
    const logger = createLogger('silent');
    const error = vi.spyOn(logger, 'error');
    const cancellation = createE2ERestartCancellation(() => true);
    const decorate = vi.fn(cancellation.decorate);
    await writeFile(
      path.join(root, 'vite.config.mjs'),
      `export default {customLogger:{hasWarned:true,info(){},warn(){},warnOnce(){},error(){},clearScreen(){},hasErrorLogged(){return false;}}};`
    );
    const server = await create(
      {
        configFile: undefined,
        plugins: [
          {
            name: 'application-selected-logger',
            enforce: 'post',
            config: {
              order: 'post',
              handler(raw) {
                raw.customLogger = logger;
              },
            },
          },
        ],
      },
      decorate
    );
    expect(decorate).toHaveBeenCalledExactlyOnceWith(logger);
    expect(server.config.logger.hasWarned).toBe(false);
    logger.hasWarned = true;
    expect(server.config.logger.hasWarned).toBe(true);
    server.config.logger.error(String(cancellation.error()));
    expect(error).not.toHaveBeenCalled();
    server.config.logger.error('Genuine application error');
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'Genuine application error',
      undefined
    );
  });
});

it('runs a transform installed on an immutable plugin facade during configuration', async () => {
  await harness(async ({ create, root }) => {
    await writeFile(
      path.join(root, 'frozen.js'),
      'export const value = "before";'
    );
    const transform = vi.fn((code: string, id: string) =>
      id.endsWith('/frozen.js') ? code.replace('before', 'after') : undefined
    );
    const plugin = Object.freeze({
      name: 'frozen-late-transform',
      configResolved(config: ResolvedConfig) {
        config.plugins.find(
          (candidate) => candidate.name === 'frozen-late-transform'
        )!.transform = transform;
      },
    });
    const server = await create({ plugins: [plugin] });
    expect((await server.transformRequest('/frozen.js'))?.code).toContain(
      'after'
    );
    expect(transform).toHaveBeenCalled();
    expect(Object.hasOwn(plugin, 'transform')).toBe(false);
  });
});
