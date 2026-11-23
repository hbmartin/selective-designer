import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  InlineConfig,
  Plugin,
  PluginOption,
  ResolvedConfig,
  UserConfig,
  ViteDevServer,
} from 'vite';

const ownerName = 'e2e-owned-database';
export type ViteOwnerApi = {
  prepare(config: ResolvedConfig): void;
  register(server: ViteDevServer): void;
  isFinalClose?: () => boolean;
};
function owner(config: ResolvedConfig): ViteOwnerApi {
  const api = config.plugins.find((plugin) => plugin.name === ownerName)
    ?.api as ViteOwnerApi | undefined;
  if (!api) throw new Error('E2E Vite configuration has no resource owner');
  return api;
}
const decorated = new WeakSet<Plugin>();
const facades = new WeakMap<Plugin, Plugin>();
const lifecycleKeys = [
  'configResolved',
  'configureServer',
  'closeServer',
] as const;
/** Keep immutable source plugins intact while allowing ownership instrumentation. */
function writablePlugin(source: Plugin): Plugin {
  const previous = facades.get(source);
  if (previous) return previous;
  const immutable =
    !Object.isExtensible(source) ||
    lifecycleKeys.some((key) => {
      for (
        let prototype: object | null = source;
        prototype;
        prototype = Object.getPrototypeOf(prototype)
      ) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
        if (descriptor)
          return 'writable' in descriptor
            ? !descriptor.writable
            : !descriptor.set;
      }
      return false;
    });
  if (!immutable) return source;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  for (const key of lifecycleKeys) delete descriptors[key];
  const facade = Object.create(
    Object.getPrototypeOf(source),
    descriptors
  ) as Plugin;
  for (const key of lifecycleKeys) {
    let installed: { source: unknown; value: unknown } | undefined;
    Object.defineProperty(facade, key, {
      configurable: true,
      enumerable: true,
      get() {
        const current = source[key];
        if (installed && installed.source === current) return installed.value;
        return current;
      },
      set(value: unknown) {
        installed = { source: source[key], value };
      },
    });
  }
  facades.set(source, facade);
  return facade;
}
function wrapPlugin(input: PluginOption): PluginOption {
  if (!input) return input;
  if (Array.isArray(input)) return input.map(wrapPlugin);
  if ('then' in input) return input.then(wrapPlugin);
  const plugin = writablePlugin(input);
  if (decorated.has(plugin)) return plugin;
  decorated.add(plugin);
  const resolved = plugin.configResolved;
  if (resolved) {
    const callback =
      typeof resolved === 'function' ? resolved : resolved.handler;
    const handler: typeof callback = async function (config) {
      try {
        await callback.call(this, config);
      } finally {
        owner(config).prepare(config);
      }
    };
    plugin.configResolved =
      typeof resolved === 'function' ? handler : { ...resolved, handler };
  }
  const configure = plugin.configureServer;
  if (configure) {
    const callback =
      typeof configure === 'function' ? configure : configure.handler;
    const handler: typeof callback = async function (server) {
      const api = owner(server.config);
      api.register(server);
      try {
        const post = await callback.call(this, server);
        if (post)
          return () => {
            try {
              post();
            } finally {
              api.prepare(server.config);
              api.register(server);
            }
          };
      } finally {
        api.prepare(server.config);
        api.register(server);
      }
    };
    plugin.configureServer =
      typeof configure === 'function' ? handler : { ...configure, handler };
  }
  return plugin;
}
function registrar(): Plugin {
  return {
    name: 'e2e-config-resource-registrar',
    enforce: 'pre',
    configResolved: {
      order: 'pre',
      handler(config) {
        owner(config).prepare(config);
      },
    },
    configureServer: {
      order: 'pre',
      handler(server) {
        owner(server.config).register(server);
      },
    },
  };
}
/** Runs at the raw config boundary; resolved configuration remains read-only. */
export function withE2EViteOwnership(config: UserConfig): UserConfig {
  return {
    ...config,
    plugins: [registrar(), ...(config.plugins ?? []).map(wrapPlugin)],
  };
}
export async function createOwnedViteConfig(
  inline: InlineConfig,
  ownerPlugin: Plugin
) {
  const config = {
    ...inline,
    plugins: [ownerPlugin, ...(inline.plugins ?? []).map(wrapPlugin)],
  };
  if (inline.configFile === false)
    return {
      config,
      refresh: async () => {},
      ignoreBridge: (_server: ViteDevServer) => {},
      remove: async () => {},
    };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'e2e-vite-config-'));
  const bridge = path.join(directory, 'vite.config.mjs');
  let previous: string | undefined;
  async function refresh() {
    const selected = inline.configFile
      ? path.resolve(inline.configFile)
      : ['js', 'mjs', 'ts', 'cjs', 'mts', 'cts']
          .map((extension) =>
            path.resolve(
              inline.root ?? process.cwd(),
              `vite.config.${extension}`
            )
          )
          .find(existsSync);
    const content = `${selected ? `import source from ${JSON.stringify(selected)};` : 'const source = {};'}\nimport { withE2EViteOwnership } from ${JSON.stringify(path.resolve('tests/server/vite-owned-config.ts'))};\nexport default async env => withE2EViteOwnership(await (typeof source === 'function' ? source(env) : source));\n`;
    if (content === previous) return;
    await writeFile(bridge, content);
    previous = content;
  }
  try {
    await refresh();
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'E2E config bridge creation failed',
        { cause: error }
      );
    }
    throw error;
  }
  return {
    config: { ...config, configFile: bridge },
    refresh,
    // Native config dependencies remain watched; only our generated file is inert.
    ignoreBridge: (server: ViteDevServer) => {
      server.watcher.unwatch(bridge);
    },
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}
