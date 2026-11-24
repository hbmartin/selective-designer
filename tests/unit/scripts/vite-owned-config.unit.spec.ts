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
