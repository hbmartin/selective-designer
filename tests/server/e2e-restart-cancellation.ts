import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { Logger } from 'vite';

/** Vite stringifies watcher failures; only our exact cancellations are quiet. */
export function createE2ERestartCancellation(isStopped: () => boolean) {
  const diagnostics = new Set<string>();
  const decorated = new WeakMap<Logger, Logger>();
  return {
    error() {
      const rendered = `E2ERestartCancelled[${randomUUID()}]: E2E restart cancelled before starting`;
      diagnostics.add(rendered);
      return new (class extends Error {
        constructor() {
          super('E2E restart cancelled before starting');
        }
        override toString() {
          return rendered;
        }
      })();
    },
    decorate(logger: Logger): Logger {
      const previous = decorated.get(logger);
      if (previous) return previous;
      const methods = new Map<Function, Function>();
      const error: Logger['error'] = (message, options) => {
        if (isStopped() && diagnostics.has(stripVTControlCharacters(message)))
          return;
        logger.error(message, options);
      };
      const facade = new Proxy({} as Logger, {
        get(_target, key) {
          if (key === 'error') return error;
          const value: unknown = Reflect.get(logger, key, logger);
          if (typeof value !== 'function') return value;
          if (!methods.has(value)) methods.set(value, value.bind(logger));
          return methods.get(value);
        },
        set(_target, key, value: unknown) {
          return Reflect.set(logger, key, value, logger);
        },
        has: (_target, key) => key in logger,
        ownKeys: () => Reflect.ownKeys(logger),
        getOwnPropertyDescriptor(_target, key) {
          const descriptor = Object.getOwnPropertyDescriptor(logger, key);
          return descriptor && { ...descriptor, configurable: true };
        },
      });
      decorated.set(logger, facade);
      decorated.set(facade, facade);
      return facade;
    },
  };
}
