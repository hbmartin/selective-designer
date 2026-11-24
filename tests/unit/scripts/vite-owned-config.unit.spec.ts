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
it('rejects source-only deletion while local deletion reveals the source again', () => {
  const symbol = Symbol('source');
  const source = Object.freeze({ name: 'deletion', value: 42, [symbol]: 7 });
  const facade = withE2EViteOwnership({ plugins: [source] })
    .plugins![1] as Plugin & { value: number; [symbol]: number };
  const alias = new Proxy(new Proxy(facade, {}), {});
  for (const key of ['value', symbol]) {
    expect(Reflect.deleteProperty(alias, key)).toBe(false);
    expect(Reflect.has(alias, key)).toBe(true);
    expect(Object.hasOwn(alias, key)).toBe(true);
    expect(Reflect.set(alias, key, 100)).toBe(true);
    expect(Reflect.deleteProperty(alias, key)).toBe(true);
    expect(Reflect.get(alias, key)).toBe(Reflect.get(source, key));
    expect(Reflect.deleteProperty(alias, key)).toBe(false);
  }
  expect(Reflect.deleteProperty(alias, 'missing')).toBe(true);
  expect(Reflect.deleteProperty(alias, 'toString')).toBe(true);
  expect(alias.toString).toBe(source.toString);
  Object.defineProperty(facade, 'locked', { value: 1, configurable: false });
  expect(Reflect.deleteProperty(alias, 'locked')).toBe(false);
});
it.each(['revoked', 'throwing-descriptor'] as const)(
  'does not let a %s receiver alias probe replace ordinary read or accessor behavior',
  (kind) => {
    const probeFailure = new Error('Descriptor probe rejected');
    const accessorFailure = new Error('Source accessor rejected');
    const source = Object.freeze({
      name: 'probe',
      value: 42,
      get self() {
        return this;
      },
      get rejected() {
        throw accessorFailure;
      },
      set rejected(_value: number) {
        throw accessorFailure;
      },
    });
    const facade = withE2EViteOwnership({ plugins: [source] })
      .plugins![1] as Plugin;
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const receiver =
      kind === 'revoked'
        ? revocable.proxy
        : new Proxy(
            {},
            {
              getOwnPropertyDescriptor: () => {
                throw probeFailure;
              },
            }
          );
    expect(Reflect.get(facade, 'value', receiver)).toBe(42);
    expect(Reflect.get(facade, 'missing', receiver)).toBeUndefined();
    expect(Reflect.get(facade, 'self', receiver)).toBe(receiver);
    expect(() => Reflect.get(facade, 'rejected', receiver)).toThrow(
      accessorFailure
    );
    expect(() => Reflect.set(facade, 'rejected', 1, receiver)).toThrow(
      accessorFailure
    );
    expect(() => Reflect.set(facade, 'fresh', 1, receiver)).toThrow(
      kind === 'revoked' ? TypeError : probeFailure
    );
  }
);
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

it.each(['own', 'inherited'] as const)(
  'uses derived receivers for %s source getters and setters',
  (kind) => {
    const state = new WeakMap<object, boolean>();
    const receivers: object[] = [];
    const accessor = {
      get enabled() {
        receivers.push(this);
        return state.get(this) ?? true;
      },
      set enabled(value: boolean) {
        receivers.push(this);
        state.set(this, value);
      },
    };
    const source = Object.freeze(
      kind === 'own'
        ? Object.defineProperties(
            { name: 'receivers' },
            Object.getOwnPropertyDescriptors(accessor)
          )
        : Object.assign(Object.create(accessor), { name: 'receivers' })
    );
    const facade = withE2EViteOwnership({ plugins: [source] })
      .plugins![1] as Plugin & { enabled: boolean };
    facade.enabled = false;
    const child = Object.create(facade) as typeof facade;
    expect(child.enabled).toBe(true);
    child.enabled = false;
    expect(child.enabled).toBe(false);
    const alternate = {};
    expect(Reflect.set(facade, 'enabled', true, alternate)).toBe(true);
    expect(Reflect.get(facade, 'enabled', alternate)).toBe(true);
    expect(receivers).toEqual([
      source,
      child,
      child,
      child,
      alternate,
      alternate,
    ]);
    expect(state.get(source)).toBe(false);
    expect(state.get(child)).toBe(false);
  }
);
it('puts new, data and getter-only shadows on the actual derived receiver', () => {
  const source = Object.freeze({
    name: 'parent',
    get enabled() {
      return true;
    },
  });
  const facade = withE2EViteOwnership({ plugins: [source] })
    .plugins![1] as Plugin & { enabled: boolean };
  const child = Object.create(facade);
  const symbol = Symbol('child');
  child.fresh = 42;
  child.name = 'child';
  child.enabled = false;
  child[symbol] = 'value';
  expect(Object.keys(child)).toEqual(['fresh', 'name', 'enabled']);
  expect(Reflect.ownKeys(child)).toContain(symbol);
  expect(Object.hasOwn(facade, 'fresh')).toBe(false);
  expect(Object.hasOwn(facade, symbol)).toBe(false);
  expect(facade.name).toBe('parent');
  expect(facade.enabled).toBe(true);
  const state = new WeakMap<object, number>();
  Object.defineProperty(facade, 'local', {
    configurable: true,
    get() {
      return state.get(this);
    },
    set(value: number) {
      state.set(this, value);
    },
  });
  child.local = 7;
  expect(child.local).toBe(7);
  expect(Reflect.get(facade, 'local')).toBeUndefined();
});
it('respects alternate receiver descriptors and extensibility when creating shadows', () => {
  const source = Object.freeze({ name: 'parent' });
  const facade = withE2EViteOwnership({ plugins: [source] })
    .plugins![1] as Plugin;
  const readonly = Object.defineProperty({}, 'x', {
    value: 1,
    writable: false,
    configurable: true,
  });
  const setter = vi.fn();
  const accessor = Object.defineProperty({}, 'x', {
    configurable: true,
    get: () => 1,
    set: setter,
  });
  expect(Reflect.set(facade, 'x', 2, readonly)).toBe(false);
  expect(Reflect.set(facade, 'x', 2, accessor)).toBe(false);
  expect(setter).not.toHaveBeenCalled();
  expect(Reflect.set(facade, 'x', 2, Object.preventExtensions({}))).toBe(false);
  expect(Reflect.set(facade, 'x', 2, Object.freeze({}))).toBe(false);
  expect(Reflect.set(facade, 'x', 2, 1)).toBe(false);
  const writable = Object.defineProperty({}, 'x', {
    value: 1,
    writable: true,
    configurable: false,
    enumerable: false,
  });
  expect(Reflect.set(facade, 'x', 2, writable)).toBe(true);
  expect(Object.getOwnPropertyDescriptor(writable, 'x')).toEqual({
    value: 2,
    writable: true,
    configurable: false,
    enumerable: false,
  });
  expect(Object.hasOwn(facade, 'x')).toBe(false);
});

it.each(['writable', 'frozen', 'getter'] as const)(
  'keeps %s source shadows writable through nested forwarding wrappers',
  (kind) => {
    const sources = {
      writable: Object.preventExtensions({ name: 'writable', transform: 1 }),
      frozen: Object.freeze({ name: 'frozen', transform: 1 }),
      getter: Object.freeze({
        name: 'getter',
        get transform() {
          return 1;
        },
      }),
    };
    const source = sources[kind];
    const facade = withE2EViteOwnership({
      plugins: [source as unknown as Plugin],
    }).plugins![1] as unknown as { transform: number };
    const outer = new Proxy(new Proxy(facade, {}), {});
    outer.transform = 2;
    expect(Object.getOwnPropertyDescriptor(facade, 'transform')).toEqual({
      value: 2,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    facade.transform = 3;
    outer.transform = 4;
    expect(facade.transform).toBe(4);
    expect(Object.keys(facade)).toContain('transform');
    expect(source.transform).toBe(1);
    expect(Reflect.deleteProperty(outer, 'transform')).toBe(true);
    expect(outer.transform).toBe(1);
  }
);
it('uses the source for private accessors through aliases without binding methods', () => {
  class Source {
    name = 'private-accessors';
    #value = 1;
    get value() {
      return this.#value;
    }
    set value(value: number) {
      this.#value = value;
    }
    method() {
      return this;
    }
  }
  const source = Object.freeze(new Source());
  const facade = withE2EViteOwnership({ plugins: [source] })
    .plugins![1] as unknown as Source;
  const alias = new Proxy(new Proxy(facade, {}), {});
  alias.value = 2;
  expect(alias.value).toBe(2);
  expect(Reflect.get(facade, 'value', alias)).toBe(2);
  expect(source.value).toBe(2);
  expect(alias.method).toBe(source.method);
  expect(alias.method()).toBe(alias);
  expect(() => Object.create(alias).value).toThrow(TypeError);
});
it('preserves actual derived and local-accessor receivers through aliases', () => {
  const state = new WeakMap<object, number>();
  const source = Object.freeze({
    name: 'receivers',
    get value() {
      return state.get(this) ?? 0;
    },
    set value(value: number) {
      state.set(this, value);
    },
  });
  const facade = withE2EViteOwnership({ plugins: [source] })
    .plugins![1] as Plugin & { value: number; local: number };
  const alias = new Proxy(facade, {});
  const derived = Object.create(alias) as typeof facade;
  const foreign = {};
  alias.value = 1;
  derived.value = 2;
  Reflect.set(facade, 'value', 3, foreign);
  expect(state.get(source)).toBe(1);
  expect(derived.value).toBe(2);
  expect(Reflect.get(facade, 'value', foreign)).toBe(3);
  Object.defineProperty(facade, 'local', {
    configurable: true,
    get() {
      return state.get(this);
    },
    set(value: number) {
      state.set(this, value);
    },
  });
  alias.local = 4;
  derived.local = 5;
  expect(state.get(alias)).toBe(4);
  expect(state.get(derived)).toBe(5);
  expect(state.has(facade)).toBe(false);
});
it('allows forwarding-wrapper traps to reject source shadows', () => {
  const source = Object.freeze({ name: 'rejecting', transform: 1 });
  const facade = withE2EViteOwnership({
    plugins: [source as unknown as Plugin],
  }).plugins![1] as unknown as { transform: number };
  const define = vi.fn(() => false);
  const outer = new Proxy(facade, { defineProperty: define });
  expect(Reflect.set(outer, 'transform', 2)).toBe(false);
  expect(define).toHaveBeenCalledExactlyOnceWith(facade, 'transform', {
    value: 2,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  expect(facade.transform).toBe(1);
});
it('hides and protects alias bookkeeping against observing wrappers', () => {
  const facade = withE2EViteOwnership({
    plugins: [Object.freeze({ name: 'hidden' })],
  }).plugins![1] as Plugin & { added: number };
  let marker: symbol | undefined;
  let token: unknown;
  const outer = new Proxy(facade, {
    getOwnPropertyDescriptor(object, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
      if (typeof key === 'symbol') {
        marker = key;
        token = descriptor?.value;
      }
      return descriptor;
    },
  });
  outer.added = 1;
  expect(marker).toBeTypeOf('symbol');
  expect(token).toEqual({});
  expect(token).not.toBe(facade);
  expect(Reflect.ownKeys(facade)).not.toContain(marker);
  expect(Reflect.defineProperty(outer, marker!, { configurable: false })).toBe(
    false
  );
  expect(Reflect.deleteProperty(outer, marker!)).toBe(false);
  expect(Reflect.preventExtensions(outer)).toBe(false);
  expect(() => Reflect.ownKeys(outer)).not.toThrow();
  outer.added = 2;
  expect(facade.added).toBe(2);
});
it('retains facade-wide lifecycle overlays across aliases and derived objects', () => {
  const original = async () => {};
  const source = Object.freeze({
    name: 'shared-lifecycle',
    closeServer: original,
  });
  const facade = withE2EViteOwnership({ plugins: [source] })
    .plugins![1] as Plugin;
  const alias = new Proxy(facade, {});
  const child = Object.create(alias) as Plugin;
  const sibling = Object.create(facade) as Plugin;
  const replacement = async () => {};
  child.closeServer = replacement;
  expect(facade.closeServer).toBe(replacement);
  expect(alias.closeServer).toBe(replacement);
  expect(sibling.closeServer).toBe(replacement);
  expect(source.closeServer).toBe(original);
});
