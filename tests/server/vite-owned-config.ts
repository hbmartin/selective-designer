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
};
function owner(config: ResolvedConfig): ViteOwnerApi {
  const api = config.plugins.find((plugin) => plugin.name === ownerName)
    ?.api as ViteOwnerApi | undefined;
  if (!api) throw new Error('E2E Vite configuration has no resource owner');
  return api;
}
const decorated = new WeakSet<Plugin>();
function wrapPlugin(input: PluginOption): PluginOption {
  if (!input) return input;
  if (Array.isArray(input)) return input.map(wrapPlugin);
  if ('then' in input) return input.then(wrapPlugin);
  const plugin: Plugin = input;
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
            }
          };
      } finally {
        api.prepare(server.config);
      }
    };
    plugin.configureServer =
      typeof configure === 'function' ? handler : { ...configure, handler };
  }
  return input;
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
  if (inline.configFile === false) return { config, remove: async () => {} };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'e2e-vite-config-'));
  const selected = path.resolve(
    inline.configFile ??
      path.join(inline.root ?? process.cwd(), 'vite.config.ts')
  );
  const bridge = path.join(directory, 'vite.config.mjs');
  try {
    await writeFile(
      bridge,
      `import source from ${JSON.stringify(selected)};\nimport { withE2EViteOwnership } from ${JSON.stringify(path.resolve('tests/server/vite-owned-config.ts'))};\nexport default async env => withE2EViteOwnership(await (typeof source === 'function' ? source(env) : source));\n`
    );
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
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}
