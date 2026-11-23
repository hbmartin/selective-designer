import { AsyncLocalStorage } from 'node:async_hooks';
import { DevEnvironment, type ResolvedConfig } from 'vite';
import { beforeDeadline } from '../support/promise-deadline';

type Closeable = { close(): unknown };
type NativeClose = {
  target: Closeable;
  pending: Set<Promise<unknown>>;
  failures: unknown[];
  attempted: boolean;
  nativeAttempted: boolean;
  native: () => Promise<unknown>;
};
type Scope = {
  acquisitions: Promise<unknown>[];
  hooks: Promise<unknown>[];
  resources: NativeClose[];
  failures: unknown[];
  finishing?: Promise<unknown[]>;
  settled: boolean;
  registered: boolean;
  result?: unknown[];
  deadline?: number;
  started: Promise<number>;
  start: (deadline: number) => void;
  teardown: Promise<void>;
  markTeardown: () => void;
};

export class ViteRetirementTimeout extends Error {
  constructor(cause: unknown) {
    super('E2E Vite retirement exceeded five seconds', { cause });
  }
}

/** Observes public promises, without claiming completion of private closers. */
export function createViteResourceObserver() {
  const scopes = new Map<ResolvedConfig, Scope>();
  const released = new WeakMap<ResolvedConfig, unknown[]>();
  const historical = new Set<unknown>();
  const context = new AsyncLocalStorage<{
    scope: Scope;
  }>();
  const factories = new WeakSet<Function>();
  const hooks = new WeakSet<Function>();
  function scopeFor(config: ResolvedConfig) {
    let scope = scopes.get(config);
    if (!scope) {
      let start!: (deadline: number) => void;
      let markTeardown!: () => void;
      const started = new Promise<number>((resolve) => {
        start = resolve;
      });
      const teardown = new Promise<void>((resolve) => {
        markTeardown = resolve;
      });
      scope = {
        acquisitions: [],
        hooks: [],
        resources: [],
        failures: [],
        settled: false,
        registered: false,
        started,
        start,
        teardown,
        markTeardown,
      };
      scopes.set(config, scope);
    }
    return scope;
  }
  function observed<T>(promise: Promise<T>) {
    void promise.catch(() => {});
    return promise;
  }
  function begin(scope: Scope) {
    scope.deadline ??= performance.now() + 5_000;
    scope.start(scope.deadline);
  }
  function capture(scope: Scope, target: Closeable) {
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
      begin(scope);
      const promise = observed(
        context.run({ scope }, () =>
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
  async function closePublicParts(scope: Scope, environment: DevEnvironment) {
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
        const resource = capture(scope, target);
        if (!resource.attempted) await target.close();
        else await Promise.allSettled(resource.pending);
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
  function prepare(config: ResolvedConfig) {
    const scope = scopeFor(config);
    // These reads must not populate Vite's cached sorted-hook membership/order.
    for (const plugin of config.plugins ?? []) {
      try {
        const hook = plugin.closeServer;
        if (!hook) continue;
        const original = typeof hook === 'function' ? hook : hook.handler;
        if (hooks.has(original)) continue;
        const wrapper: typeof original = function (
          this: ThisParameterType<typeof original>,
          ...args: Parameters<typeof original>
        ) {
          // Shared plugins must not retain their first generation's scope.
          const active = context.getStore()?.scope;
          const promise = observed(
            Promise.resolve().then(() => original.apply(this, args))
          );
          active?.hooks.push(promise);
          return promise;
        };
        hooks.add(wrapper);
        plugin.closeServer =
          typeof hook === 'function' ? wrapper : { ...hook, handler: wrapper };
      } catch (error) {
        scope.failures.push(error);
      }
    }
    for (const options of Object.values(config.environments ?? {})) {
      try {
        const original = options.dev.createEnvironment;
        if (factories.has(original)) continue;
        const wrapper: typeof original = async (...args) => {
          const [, , factoryContext] = args;
          capture(scope, factoryContext.ws);
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
          const close = environment.close;
          let initializationFailed = false;
          if (close === DevEnvironment.prototype.close) {
            environment.close = function () {
              if (initializationFailed) {
                try {
                  void environment.pluginContainer;
                } catch {
                  // Default close requires a container that failed init never exposed.
                  // Drain public parts, without claiming disposal of hidden internals.
                  return closePublicParts(scope, environment);
                }
              }
              return close.call(environment);
            };
          }
          capture(scope, environment);
          const initialize = environment.init.bind(environment);
          environment.init = (input) => {
            if (input?.watcher) capture(scope, input.watcher);
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
      } catch (error) {
        scope.failures.push(error);
      }
    }
  }
  function run<T>(config: ResolvedConfig, action: () => T): T {
    prepare(config);
    return context.run({ scope: scopeFor(config) }, action);
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
          if (!resource.attempted)
            await Promise.resolve()
              .then(() => resource.target.close())
              .catch((error: unknown) => {
                scope.failures.push(error);
              });
          // An outer wrapper may fail before delegating. This is the native
          // closer's first attempt, never a retry or replay of the wrapper.
          if (!resource.nativeAttempted) await resource.native();
        })
      );
      for (const outcome of outcomes)
        if (outcome.status === 'rejected') scope.failures.push(outcome.reason);
    }
    while (true) {
      const count = scope.hooks.length;
      await Promise.allSettled([
        ...scope.hooks,
        ...scope.resources.flatMap((resource) => [...resource.pending]),
      ]);
      if (
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
    scope.result = failures;
    scope.settled = true;
    return failures;
  }
  function settle(config: ResolvedConfig, _deadline?: number) {
    const previous = released.get(config);
    if (previous) return Promise.resolve(previous);
    const scope = scopeFor(config);
    scope.finishing ??= finish(scope);
    return scope.finishing;
  }
  function release(config: ResolvedConfig) {
    const scope = scopes.get(config);
    if (!scope?.settled) return false;
    const failures = scope.result!;
    released.set(config, failures);
    for (const error of failures) historical.add(error);
    scopes.delete(config);
    return true;
  }
  return {
    prepare,
    run,
    settle,
    release,
    register(config: ResolvedConfig) {
      prepare(config);
      scopeFor(config).registered = true;
    },
    markTeardown() {
      const scope = context.getStore()?.scope;
      if (scope) {
        begin(scope);
        scope.markTeardown();
      }
    },
    deadline(config: ResolvedConfig) {
      return scopes.get(config)?.deadline;
    },
    async boundRestart(config: ResolvedConfig, operation: Promise<void>) {
      const scope = scopeFor(config);
      const retirement = scope.started.then(async (deadline) => {
        const ready = Promise.race([
          scope.teardown,
          operation.then(
            () => {},
            () => {}
          ),
        ]).then(() => settle(config));
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
      // Retirement ends independently of replacement listen. No timer covers listen.
      return Promise.race([operation, retirement.then(() => operation)]);
    },
    async settleStarted(config: ResolvedConfig, _deadline?: number) {
      const scope = scopes.get(config);
      return !scope || (scope.deadline === undefined && !scope.hooks.length)
        ? []
        : settle(config);
    },
    async settleOrphans(_deadline?: number) {
      // Registered instances are settled explicitly by their coordinator.
      const selected = [...scopes.entries()].filter(
        ([, scope]) => !scope.registered && !scope.finishing
      );
      const results = await Promise.all(
        selected.map(async ([config]) => {
          const result = await settle(config);
          release(config);
          return result;
        })
      );
      return results.flat();
    },
    async settleAll() {
      const selected = [...scopes.keys()];
      const results = await Promise.all(
        selected.map((config) => settle(config))
      );
      for (const config of selected) release(config);
      return [...new Set([...historical, ...results.flat()])];
    },
  };
}
