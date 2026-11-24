import { afterEach, expect, it, vi } from 'vitest';
import type { Plugin } from 'vite';
import {
  createOwnedViteConfig,
  withE2EViteOwnership,
} from '@tests/server/vite-owned-config';

const mocks = vi.hoisted(() => ({
  allocated: '/synthetic/e2e-config',
  canonicalization: new Error('Canonicalization failed'),
  rm: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  mkdtemp: async () => mocks.allocated,
  realpath: async () => {
    throw mocks.canonicalization;
  },
  rm: mocks.rm,
}));
afterEach(() => vi.resetAllMocks());

it('adds writable plugin-local properties without mutating immutable sources', () => {
  let live = 'first';
  const symbol = Symbol('source');
  const source = Object.freeze({
    name: 'frozen',
    [symbol]: 42,
    get description() {
      expect(this).toBe(source);
      return live;
    },
  });
  const config = withE2EViteOwnership({ plugins: [source] });
  const plugin = config.plugins![1] as Plugin & { description: string };
  const transform = vi.fn();
  plugin.transform = transform;
  expect(plugin.transform).toBe(transform);
  expect(Object.hasOwn(source, 'transform')).toBe(false);
  expect(plugin.description).toBe('first');
  live = 'second';
  expect(plugin.description).toBe('second');
  expect(Reflect.get(plugin, symbol)).toBe(42);
  expect(Reflect.ownKeys(plugin)).toContain(symbol);
  plugin.name = 'local';
  expect(plugin.name).toBe('local');
  expect(source.name).toBe('frozen');
  Reflect.deleteProperty(plugin, 'name');
  expect(plugin.name).toBe('frozen');
  Object.defineProperty(plugin, 'local', { value: 7, configurable: false });
  expect(Reflect.get(plugin, 'local')).toBe(7);
  expect(Reflect.deleteProperty(plugin, 'local')).toBe(false);
  expect(Reflect.preventExtensions(plugin)).toBe(false);
});
it('cleans the allocated directory when realpath fails', async () => {
  await expect(createOwnedViteConfig({}, { name: 'owner' })).rejects.toBe(
    mocks.canonicalization
  );
  expect(mocks.rm).toHaveBeenCalledExactlyOnceWith(mocks.allocated, {
    recursive: true,
    force: true,
  });
});
it('retains canonicalization before a secondary directory cleanup failure', async () => {
  const cleanup = new Error('Removal failed');
  mocks.rm.mockRejectedValue(cleanup);
  await expect(
    createOwnedViteConfig({}, { name: 'owner' })
  ).rejects.toMatchObject({
    cause: mocks.canonicalization,
    errors: [mocks.canonicalization, cleanup],
  });
});

it.each(['own', 'inherited'] as const)(
  'forwards a frozen plugin %s accessor setter with the source receiver',
  (kind) => {
    let enabled = true;
    let reads = 0;
    let source: object;
    const setter = vi.fn(function (this: object, value: boolean) {
      expect(this).toBe(source);
      enabled = value;
    });
    const accessor = {
      get enabled() {
        reads++;
        return enabled;
      },
      set enabled(value: boolean) {
        setter.call(this, value);
      },
    };
    source = Object.freeze(
      kind === 'own'
        ? Object.defineProperties(
            { name: 'accessor' },
            Object.getOwnPropertyDescriptors(accessor)
          )
        : Object.assign(Object.create(accessor), { name: 'accessor' })
    );
    const facade = withE2EViteOwnership({ plugins: [source as Plugin] })
      .plugins![1] as Plugin & { enabled: boolean };
    facade.enabled = false;
    expect(reads).toBe(0);
    expect(setter).toHaveBeenCalledOnce();
    expect(enabled).toBe(false);
    expect(facade.enabled).toBe(false);
  }
);
it('preserves setter exceptions and gives explicit local descriptors precedence', () => {
  const failure = new Error('Setter rejected');
  const sourceSetter = vi.fn((_value: boolean) => {
    throw failure;
  });
  const source = Object.freeze({
    name: 'setter',
    get enabled() {
      return true;
    },
    set enabled(value: boolean) {
      sourceSetter(value);
    },
  });
  const facade = withE2EViteOwnership({ plugins: [source] })
    .plugins![1] as Plugin & { enabled: boolean };
  expect(() => {
    facade.enabled = false;
  }).toThrow(failure);
  expect(facade.enabled).toBe(true);
  let local = true;
  const localSetter = vi.fn(function (this: object, value: boolean) {
    expect(this).toBe(facade);
    local = value;
  });
  Object.defineProperty(facade, 'enabled', {
    configurable: true,
    get: () => local,
    set: localSetter,
  });
  facade.enabled = false;
  expect(local).toBe(false);
  expect(sourceSetter).toHaveBeenCalledOnce();
  Object.defineProperty(facade, 'enabled', { value: true, writable: false });
  expect(Reflect.set(facade, 'enabled', false)).toBe(false);
  Reflect.deleteProperty(facade, 'enabled');
  expect(() => {
    facade.enabled = false;
  }).toThrow(failure);
});
it('keeps getter-only shadows and lifecycle setters local to the writable facade', () => {
  const original = async () => {};
  const sourceSetter = vi.fn();
  const source = Object.freeze({
    name: 'local-overrides',
    get enabled() {
      return true;
    },
    get closeServer() {
      return original;
    },
    set closeServer(value) {
      sourceSetter(value);
    },
  });
  const facade = withE2EViteOwnership({ plugins: [source] })
    .plugins![1] as Plugin & { enabled: boolean };
  facade.enabled = false;
  expect(facade.enabled).toBe(false);
  expect(source.enabled).toBe(true);
  Reflect.deleteProperty(facade, 'enabled');
  expect(facade.enabled).toBe(true);
  const replacement = async () => {};
  facade.closeServer = replacement;
  expect(facade.closeServer).toBe(replacement);
  expect(source.closeServer).toBe(original);
  expect(sourceSetter).not.toHaveBeenCalled();
});
