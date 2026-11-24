import { AsyncLocalStorage } from 'node:async_hooks';
import { DevEnvironment, type ResolvedConfig, type ViteDevServer } from 'vite';
import { beforeDeadline } from '../support/promise-deadline';

type Closeable = { close(): unknown };
type NativeClose = {
  target: Closeable;
  pending: Set<Promise<unknown>>;
  failures: unknown[];
  attempted: boolean;
  nativeAttempted: boolean;
  native: () => Promise<unknown>;
  parent?: NativeClose;
  independent?: boolean;
  retirement?: Promise<void>;
};
type Scope = {
  token: object;
  acquisitions: Promise<unknown>[];
  hooks: Promise<unknown>[];
  resources: NativeClose[];
  failures: unknown[];
  finishing?: Promise<unknown[]>;
  settled: boolean;
  registered: boolean;
  result?: unknown[];
  attempt?: CleanupAttempt;
};
type CleanupAttempt = {
  deadline?: number;
  started: Promise<number>;
  start: (deadline: number) => void;
  teardown: Promise<void>;
  markTeardown: () => void;
  teardownMarked: boolean;
};

export class ViteRetirementTimeout extends Error {
  constructor(cause: unknown) {
    super('E2E Vite retirement exceeded five seconds', { cause });
  }
}

/** Observes public promises, without claiming completion of private closers. */
export function createViteResourceObserver(
  callbacks: {
    onListen?: (server: ViteDevServer) => void;
    onBegin?: (deadline: number, config: ResolvedConfig) => void;
  } = {}
) {
  const scopes = new Map<object, { config: ResolvedConfig; scope: Scope }>();
  const tokens = new WeakMap<ResolvedConfig, object>();
  function tokenFor(config: ResolvedConfig) {
    let token = tokens.get(config);
    if (!token) {
      token = {};
      tokens.set(config, token);
    }
    return token;
  }
  const released = new WeakMap<ResolvedConfig, unknown[]>();
  const historical = new Set<unknown>();
  const context = new AsyncLocalStorage<{
    token: object;
  }>();
  const factories = new WeakSet<Function>();
  const hooks = new WeakSet<Function>();
  const instrumentationFailures = new WeakMap<
    object,
    Map<
      string,
      {
        descriptor?: PropertyDescriptor;
        owner?: object;
        extensible: boolean;
        value: unknown;
        phase: 'read' | 'install';
        error: unknown;
      }
    >
  >();
  function scopeFor(config: ResolvedConfig) {
    if (released.has(config)) return undefined;
    const token = tokenFor(config);
    let scope = scopes.get(token)?.scope;
    if (!scope) {
      scope = {
        token,
        acquisitions: [],
        hooks: [],
        resources: [],
        failures: [],
        settled: false,
        registered: false,
      };
      scopes.set(token, { config, scope });
    }
    return scope;
  }
  function observed<T>(promise: Promise<T>) {
    void promise.catch(() => {});
    return promise;
  }
  function attemptFor(scope: Scope) {
    if (!scope.attempt) {
      const started = Promise.withResolvers<number>();
      const teardown = Promise.withResolvers<void>();
      scope.attempt = {
        started: started.promise,
        start: started.resolve,
        teardown: teardown.promise,
        markTeardown: teardown.resolve,
        teardownMarked: false,
      };
    }
    return scope.attempt;
  }
  function begin(token: object, attempt: CleanupAttempt) {
    attempt.deadline ??= performance.now() + 5_000;
    attempt.start(attempt.deadline);
    const entry = scopes.get(token);
    if (entry) callbacks.onBegin?.(attempt.deadline, entry.config);
  }
  function capture(scope: Scope, token: object, target: Closeable) {
    const existing = scope.resources.find(
      (resource) => resource.target === target
    );
    if (existing) return existing;
    const resource: NativeClose = {
      target,
      pending: new Set(),
      failures: [],
      attempted: false,
      nativeAttempted: false,
      native: async () => {},
    };
    scope.resources.push(resource);
    function invoke(callback: Closeable['close']) {
      if (scopes.get(token)?.scope.attempt) begin(token, scope.attempt!);
      const promise = observed(
        context.run({ token }, () =>
          Promise.resolve().then(() => callback.call(target))
        )
      );
      resource.pending.add(promise);
      void promise.then(
        () => resource.pending.delete(promise),
        (error: unknown) => {
          resource.failures.push(error);
          resource.pending.delete(promise);
        }
      );
      return promise;
    }
    const original = target.close;
    let nativeResult: Promise<unknown> | undefined;
    resource.native = () => {
      resource.nativeAttempted = true;
      nativeResult ??= invoke(original);
      return nativeResult;
    };
    function wrap(callback: Closeable['close']) {
      return function () {
        resource.attempted = true;
        return invoke(callback);
      };
    }
    let current = wrap(resource.native);
    Object.defineProperty(target, 'close', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (callback: Closeable['close']) => {
        current = wrap(callback);
      },
    });
    return resource;
  }
  function retire(scope: Scope, resource: NativeClose) {
    // Reserve before yielding. Public wrappers stay separate so a captured
    // closer can delegate without awaiting its own outer retirement.
    resource.retirement ??= observed(
      Promise.resolve().then(async () => {
        if (!resource.attempted) {
          try {
            await resource.target.close();
          } catch (error) {
            scope.failures.push(error);
          }
        }
        while (resource.pending.size)
          await Promise.allSettled(resource.pending);
        if (!resource.nativeAttempted) {
          try {
            await resource.native();
          } catch (error) {
            scope.failures.push(error);
          }
        }
      })
    );
    return resource.retirement;
  }
  async function closePublicParts(
    scope: Scope,
    token: object,
    environment: DevEnvironment
  ) {
    const targets = [
      ...new Set(
        [
          environment.hot,
          environment.depsOptimizer,
          environment.bundledDev,
        ].filter((target): target is NonNullable<typeof target> => !!target)
      ),
    ];
    const outcomes = await Promise.allSettled(
      targets.map(async (target) => {
        const resource = capture(scope, token, target);
        // This runs inside the environment closer: waiting on its parent here
        // would deadlock. The shared websocket has independent retirement.
        if (!resource.independent) await retire(scope, resource);
      })
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : []
    );
    if (failures.length)
      throw new AggregateError(
        failures,
        'E2E partially initialized environment cleanup failed',
        { cause: failures[0] }
      );
  }
  function instrument(
    scope: Scope,
    target: object,
    key: string,
    install: (value: unknown) => void
  ) {
    let descriptor: PropertyDescriptor | undefined;
    let descriptorOwner: object | undefined;
    for (
      let owner: object | null = target;
      owner;
      owner = Object.getPrototypeOf(owner)
    ) {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        descriptorOwner = owner;
        break;
      }
    }
    const extensible = Object.isExtensible(target);
    const previous = instrumentationFailures.get(target)?.get(key);
    const unchanged =
      previous &&
      previous.owner === descriptorOwner &&
      previous.extensible === extensible &&
      ['value', 'get', 'set', 'writable', 'configurable', 'enumerable'].every(
        (part) =>
          Reflect.get(previous.descriptor ?? {}, part) ===
          Reflect.get(descriptor ?? {}, part)
      );
    let value: unknown;
    let phase: 'read' | 'install' = 'read';
    try {
      value = Reflect.get(target, key);
      phase = 'install';
      if (
        unchanged &&
        previous.phase === 'install' &&
        previous.value === value
      ) {
        if (!scope.failures.includes(previous.error))
          scope.failures.push(previous.error);
        return;
      }
      install(value);
      instrumentationFailures.get(target)?.delete(key);
    } catch (error) {
      if (
        unchanged &&
        previous.phase === phase &&
        (phase === 'read' || previous.value === value)
      ) {
        if (!scope.failures.includes(previous.error))
          scope.failures.push(previous.error);
        return;
      }
      const failures = instrumentationFailures.get(target) ?? new Map();
      failures.set(key, {
        descriptor,
        owner: descriptorOwner,
        extensible,
        value,
        phase,
        error,
      });
      instrumentationFailures.set(target, failures);
      scope.failures.push(error);
    }
  }
  function prepare(config: ResolvedConfig) {
    if (released.has(config)) return;
    const token = tokenFor(config);
    const scope = scopeFor(config)!;
    // These reads must not populate Vite's cached sorted-hook membership/order.
    for (const plugin of config.plugins ?? []) {
      instrument(scope, plugin, 'closeServer', (value) => {
        const hook = value as typeof plugin.closeServer;
        if (!hook) return;
        const original = typeof hook === 'function' ? hook : hook.handler;
        if (hooks.has(original)) return;
        const wrapper: typeof original = function (
          this: ThisParameterType<typeof original>,
          ...args: Parameters<typeof original>
        ) {
          // Shared plugins must not retain their first generation's scope.
          const active = scopes.get(context.getStore()?.token ?? {})?.scope;
          const promise = observed(
            Promise.resolve().then(() => original.apply(this, args))
          );
          active?.hooks.push(promise);
          return promise;
        };
        hooks.add(wrapper);
        plugin.closeServer =
          typeof hook === 'function' ? wrapper : { ...hook, handler: wrapper };
      });
    }
    for (const options of Object.values(config.environments ?? {})) {
      instrument(scope, options.dev, 'createEnvironment', (value) => {
        const original = value as typeof options.dev.createEnvironment;
        if (factories.has(original)) return;
        const wrapper: typeof original = async (...args) => {
          const scope = scopes.get(token)?.scope;
          if (!scope) return original(...args);
          const [, , factoryContext] = args;
          const websocket = capture(scope, token, factoryContext.ws);
          websocket.independent = true;
          websocket.parent = undefined;
          const operation = observed(
            Promise.resolve().then(() => original(...args))
          );
          scope.acquisitions.push(operation);
          let environment: DevEnvironment;
          try {
            environment = (await operation) as DevEnvironment;
          } catch (error) {
            environment = new (class extends DevEnvironment {
              override async init() {
                throw error;
              }
              override async close() {}
            })(args[0], args[1], { hot: false });
          }
          const parts = [
            environment.hot,
            environment.depsOptimizer,
            environment.bundledDev,
          ]
            .filter((target): target is NonNullable<typeof target> => !!target)
            .map((target) => capture(scope, token, target));
          const close = environment.close;
          let initializationFailed = false;
          environment.close = async function () {
            const failures: unknown[] = [];
            try {
              await close.call(environment);
            } catch (error) {
              failures.push(error);
            }
            if (initializationFailed) {
              try {
                await closePublicParts(scope, token, environment);
              } catch (error) {
                failures.push(error);
              }
            }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1)
              throw new AggregateError(
                failures,
                'E2E environment cleanup failed after initialization',
                { cause: failures[0] }
              );
          };
          const owner = capture(scope, token, environment);
          for (const part of parts)
            if (part !== owner && !part.independent) part.parent ??= owner;
          const listen = environment.listen;
          if (listen)
            environment.listen = function (server) {
              callbacks.onListen?.(server);
              return listen.call(this, server);
            };
          const initialize = environment.init.bind(environment);
          environment.init = (input) => {
            if (input?.watcher) capture(scope, token, input.watcher);
            const initializing = observed(
              Promise.resolve()
                .then(() => initialize(input))
                .catch((error: unknown) => {
                  initializationFailed = true;
                  throw error;
                })
            );
            scope.acquisitions.push(initializing);
            return initializing as Promise<void>;
          };
          return environment;
        };
        factories.add(wrapper);
        options.dev.createEnvironment = wrapper;
      });
    }
  }
  function run<T>(config: ResolvedConfig, action: () => T): T {
    prepare(config);
    if (!scopeFor(config)) return action();
    return context.run({ token: tokenFor(config) }, action);
  }
  async function finish(scope: Scope) {
    for (let count = -1; count !== scope.acquisitions.length;) {
      count = scope.acquisitions.length;
      await Promise.allSettled(scope.acquisitions);
    }
    // A failing outer close or registration must not strand exposed resources.
    for (let count = -1; count !== scope.resources.length;) {
      count = scope.resources.length;
      const outcomes = await Promise.allSettled(
        scope.resources.map(async (resource) => {
          if (resource.parent) await retire(scope, resource.parent);
          await retire(scope, resource);
        })
      );
      for (const outcome of outcomes)
        if (outcome.status === 'rejected') scope.failures.push(outcome.reason);
    }
    const failures = await observeScope(scope);
    scope.result = failures;
    scope.settled = true;
    return failures;
  }
  async function observeScope(scope: Scope) {
    while (true) {
      const acquisitions = scope.acquisitions.length;
      const count = scope.hooks.length;
      await Promise.allSettled([
        ...scope.acquisitions,
        ...scope.hooks,
        ...scope.resources.flatMap((resource) => [...resource.pending]),
      ]);
      if (
        acquisitions === scope.acquisitions.length &&
        count === scope.hooks.length &&
        scope.resources.every((resource) => resource.pending.size === 0)
      )
        break;
    }
    const outcomes = await Promise.allSettled(scope.hooks);
    const failures = [
      ...new Set([
        ...scope.failures,
        ...outcomes.flatMap((outcome) =>
          outcome.status === 'rejected' ? [outcome.reason as unknown] : []
        ),
        ...scope.resources.flatMap((resource) => resource.failures),
      ]),
    ];
    return failures;
  }
  function settleScope(scope: Scope) {
    begin(scope.token, attemptFor(scope));
    scope.finishing ??= finish(scope);
    return scope.finishing;
  }
  function settle(config: ResolvedConfig, _deadline?: number) {
    const previous = released.get(config);
    if (previous) return Promise.resolve(previous);
    const scope = scopeFor(config)!;
    begin(tokenFor(config), attemptFor(scope));
    return settleScope(scope);
  }
  function release(config: ResolvedConfig) {
    return releaseToken(tokenFor(config));
  }
  function releaseToken(token: object) {
    const entry = scopes.get(token);
    if (!entry?.scope.settled) return false;
    const { config, scope } = entry;
    const failures = scope.result!;
    released.set(config, failures);
    for (const error of failures) historical.add(error);
    scopes.delete(token);
    // ALS descendants may retain the lightweight scope, never its resource graph.
    scope.acquisitions.length = 0;
    scope.hooks.length = 0;
    scope.resources.length = 0;
    scope.failures.length = 0;
    return true;
  }
  async function settleAndRelease(token: object) {
    const scope = scopes.get(token)?.scope;
    if (!scope) return [];
    const result = await settleScope(scope);
    releaseToken(token);
    return result;
  }
  function boundScope(scope: Scope, operation: Promise<void>) {
    const attempt = attemptFor(scope);
    const ready = observed(
      Promise.race([
        attempt.teardown,
        operation.then(
          () => {},
          () => {}
        ),
      ]).then(() =>
        attempt.teardownMarked ? settleScope(scope) : observeScope(scope)
      )
    );
    void ready.finally(() => {
      if (scope.attempt === attempt && !scope.finishing)
        scope.attempt = undefined;
    });
    const retirement = attempt.started.then(async (deadline) => {
      try {
        await beforeDeadline(
          ready,
          deadline,
          'E2E Vite retirement exceeded five seconds'
        );
      } catch (error) {
        throw new ViteRetirementTimeout(error);
      }
    });
    return Promise.race([operation, retirement.then(() => operation)]);
  }
  return {
    prepare,
    run,
    dispose<T>(config: ResolvedConfig, action: () => T): T {
      const scope = scopeFor(config);
      if (scope) begin(tokenFor(config), attemptFor(scope));
      return run(config, action);
    },
    settle,
    release,
    register(config: ResolvedConfig) {
      prepare(config);
      const scope = scopeFor(config);
      if (scope) scope.registered = true;
    },
    markTeardown() {
      const scope = scopes.get(context.getStore()?.token ?? {})?.scope;
      if (scope) {
        const attempt = attemptFor(scope);
        begin(context.getStore()!.token, attempt);
        attempt.teardownMarked = true;
        attempt.markTeardown();
      }
    },
    deadline(config: ResolvedConfig) {
      return scopes.get(tokenFor(config))?.scope.attempt?.deadline;
    },
    boundRestart(config: ResolvedConfig, operation: Promise<void>) {
      const scope = scopeFor(config);
      return scope ? boundScope(scope, operation) : operation;
    },
    settleStarted(config: ResolvedConfig, _deadline?: number) {
      const scope = scopes.get(tokenFor(config))?.scope;
      if (!scope) return Promise.resolve(released.get(config) ?? []);
      return scope.attempt?.teardownMarked
        ? settleScope(scope)
        : observeScope(scope);
    },
    async settleOrphans(_deadline?: number) {
      const selected = [...scopes.keys()].filter((token) => {
        const scope = scopes.get(token)!.scope;
        return !scope.registered && !scope.finishing;
      });
      return (await Promise.all(selected.map(settleAndRelease))).flat();
    },
    async settleAll() {
      const results = await Promise.all(
        [...scopes.keys()].map(settleAndRelease)
      );
      return [...new Set([...historical, ...results.flat()])];
    },
  };
}
