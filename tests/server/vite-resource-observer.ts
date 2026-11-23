import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { DevEnvironment, type ResolvedConfig } from 'vite';
import { beforeDeadline } from '../support/promise-deadline';

const transientCodes = new Set(['ETIMEDOUT', 'EINTR', 'EAGAIN', 'EBUSY']);
type Closeable = { close(): unknown };
type NativeClose = {
  target: Closeable;
  pending: Set<Promise<unknown>>;
  outcome?: PromiseSettledResult<unknown>;
  attempted: boolean;
};
type Scope = {
  acquisitions: Promise<unknown>[];
  hooks: Promise<unknown>[];
  resources: NativeClose[];
  hasServer: boolean;
  finishing?: Promise<unknown[]>;
  failures?: unknown[];
  deadline?: number;
  started: Promise<number>;
  start: (deadline: number) => void;
};

/** Accounts for exposed Vite promises; it cannot inspect private native closers. */
export function createViteResourceObserver(
  recovered: (error: unknown) => void
) {
  const scopes = new Map<ResolvedConfig, Scope>();
  const context = new AsyncLocalStorage<{
    scope: Scope;
    native?: NativeClose;
  }>();
  const factories = new WeakSet<Function>();
  const hooks = new WeakSet<Function>();
  function scopeFor(config: ResolvedConfig) {
    let scope = scopes.get(config);
    if (!scope) {
      let start!: (deadline: number) => void;
      const started = new Promise<number>((resolve) => {
        start = resolve;
      });
      scope = {
        acquisitions: [],
        hooks: [],
        resources: [],
        hasServer: false,
        started,
        start,
      };
      scopes.set(config, scope);
    }
    return scope;
  }
  function observed<T>(promise: Promise<T>) {
    void promise.catch(() => {});
    return promise;
  }
  function capture(scope: Scope, target: Closeable) {
    if (scope.resources.some((resource) => resource.target === target)) return;
    const resource: NativeClose = {
      target,
      pending: new Set(),
      attempted: false,
    };
    scope.resources.push(resource);
    function wrap(callback: Closeable['close']) {
      return function (this: Closeable) {
        if (context.getStore()?.native === resource) return callback.call(this);
        scope.deadline ??= performance.now() + 5_000;
        scope.start(scope.deadline);
        resource.attempted = true;
        const promise = observed(
          context.run({ scope, native: resource }, () =>
            Promise.resolve().then(() => callback.call(target))
          )
        );
        resource.pending.add(promise);
        void promise
          .then(
            (value) => {
              resource.outcome = { status: 'fulfilled', value };
            },
            (reason: unknown) => {
              resource.outcome = { status: 'rejected', reason };
            }
          )
          .finally(() => resource.pending.delete(promise));
        return promise;
      };
    }
    let current = wrap(target.close);
    // Each assigned callable gets its own wrapper. Plugins may capture and wrap
    // an older close method without recursing through a mutable current value.
    Object.defineProperty(target, 'close', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (callback: Closeable['close']) => {
        current = wrap(callback);
      },
    });
  }
  function prepare(config: ResolvedConfig) {
    const scope = scopeFor(config);
    for (const plugin of config.getSortedPlugins?.('closeServer') ?? []) {
      const hook = plugin.closeServer;
      const original = typeof hook === 'function' ? hook : hook.handler;
      if (hooks.has(original)) continue;
      const wrapper: typeof original = function (
        this: ThisParameterType<typeof original>,
        ...args: Parameters<typeof original>
      ) {
        const active = context.getStore()?.scope ?? scope;
        const promise = observed(
          Promise.resolve().then(() => original.apply(this, args))
        );
        active.hooks.push(promise);
        return promise;
      };
      hooks.add(wrapper);
      plugin.closeServer =
        typeof hook === 'function' ? wrapper : { ...hook, handler: wrapper };
    }
    for (const callback of config.getSortedPluginHooks?.('closeServer') ?? [])
      if (!hooks.has(callback))
        throw new Error(
          'E2E Vite close hook is outside the ownership observer'
        );
    for (const options of Object.values(config.environments ?? {})) {
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
          // Vite supplies its already-allocated watcher only to init(). Preserve
          // the original rejection while transferring that handle to its owner.
          environment = new (class extends DevEnvironment {
            override async init() {
              throw error;
            }
            override async close() {}
          })(args[0], args[1], { hot: false });
        }
        capture(scope, environment);
        const initialize = environment.init.bind(environment);
        environment.init = (input) => {
          if (input?.watcher) capture(scope, input.watcher);
          const initializing = observed(
            Promise.resolve().then(() => initialize(input))
          );
          scope.acquisitions.push(initializing);
          return initializing as Promise<void>;
        };
        return environment;
      };
      factories.add(wrapper);
      options.dev.createEnvironment = wrapper;
    }
  }
  function run<T>(config: ResolvedConfig, action: () => T): T {
    prepare(config);
    return context.run({ scope: scopeFor(config) }, action);
  }
  async function finish(scope: Scope, deadline: number) {
    // Factories can register init work after an earlier factory rejects.
    for (let count = -1; count !== scope.acquisitions.length;) {
      count = scope.acquisitions.length;
      await Promise.allSettled(scope.acquisitions);
    }
    if (!scope.hasServer) {
      await Promise.allSettled(
        scope.resources
          .filter((resource) => !resource.attempted)
          .map((resource) =>
            Promise.resolve().then(() => resource.target.close())
          )
      );
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
    for (const resource of scope.resources) {
      const previous = resource.outcome;
      if (previous?.status !== 'rejected') continue;
      const error = previous.reason as NodeJS.ErrnoException;
      if (
        error &&
        transientCodes.has(error.code ?? '') &&
        performance.now() + 50 < deadline
      ) {
        await delay(50);
        await Promise.resolve(resource.target.close()).catch(() => {});
        if (resource.outcome?.status === 'fulfilled')
          recovered(previous.reason);
      }
    }
    await Promise.allSettled(
      scope.resources.flatMap((resource) => [...resource.pending])
    );
    const outcomes = await Promise.allSettled(scope.hooks);
    return [
      ...new Set([
        ...outcomes.flatMap((outcome) =>
          outcome.status === 'rejected' ? [outcome.reason as unknown] : []
        ),
        ...scope.resources.flatMap((resource) =>
          resource.outcome?.status === 'rejected'
            ? [resource.outcome.reason as unknown]
            : []
        ),
      ]),
    ];
  }
  function settle(
    config: ResolvedConfig,
    deadline = performance.now() + 5_000
  ) {
    const scope = scopeFor(config);
    scope.finishing ??= finish(scope, deadline).then((failures) => {
      scope.failures = failures;
      return failures;
    });
    return scope.finishing;
  }
  /** Drops a scope only after it settled cleanly; failed scopes stay for settleAll. */
  function release(config: ResolvedConfig) {
    if (scopes.get(config)?.failures?.length !== 0) return false;
    return scopes.delete(config);
  }
  return {
    prepare,
    run,
    register(config: ResolvedConfig) {
      scopeFor(config).hasServer = true;
      prepare(config);
    },
    settle,
    deadline(config: ResolvedConfig) {
      return scopeFor(config).deadline;
    },
    async boundRestart(config: ResolvedConfig, operation: Promise<void>) {
      const expiry = scopeFor(config).started.then((deadline) =>
        beforeDeadline(
          operation,
          deadline,
          'E2E Vite retirement exceeded five seconds'
        )
      );
      return Promise.race([operation, expiry]);
    },
    async settleStarted(config: ResolvedConfig, deadline: number) {
      const scope = scopeFor(config);
      return scope.deadline === undefined && !scope.hooks.length
        ? []
        : settle(config, deadline);
    },
    /** Settles orphans not yet attempted; settleAll still reports earlier ones. */
    async settleOrphans(deadline: number) {
      const selected = [...scopes.entries()]
        .filter(([, scope]) => !scope.hasServer && !scope.finishing)
        .map(([config]) => config);
      const failures = await Promise.all(
        selected.map((config) => settle(config, deadline))
      );
      for (const config of selected) release(config);
      return failures.flat();
    },
    release,
    async settleAll() {
      const results = await Promise.all(
        [...scopes.keys()].map((config) => settle(config))
      );
      return results.flat();
    },
  };
}
