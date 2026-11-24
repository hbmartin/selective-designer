import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { Logger } from 'vite';

/** Vite stringifies watcher failures; only our exact cancellations are quiet. */
export function createE2ERestartCancellation(isStopped: () => boolean) {
  const diagnostics = new Set<string>();
  const cancellations = new WeakSet<object>();
  const decorated = new WeakMap<Logger, Logger>();
  return {
    error() {
      const rendered = `E2ERestartCancelled[${randomUUID()}]: E2E restart cancelled before starting`;
      diagnostics.add(rendered);
      const error = new (class extends Error {
        constructor() {
          super('E2E restart cancelled before starting');
        }
        override toString() {
          return rendered;
        }
      })();
      cancellations.add(error);
      return error;
    },
    decorate(logger: Logger): Logger {
      const previous = decorated.get(logger);
      if (previous) return previous;
      const methods = new Map<Function, Function>();
      const error: Logger['error'] = (message, options) => {
        if (
          isStopped() &&
          ((typeof message === 'string' &&
            diagnostics.has(stripVTControlCharacters(message))) ||
            (typeof message === 'object' &&
              message !== null &&
              cancellations.has(message)))
        )
          return;
        logger.error(message, options);
      };
      function visible(key: PropertyKey) {
        if (key === 'error') return error;
        const value: unknown = Reflect.get(logger, key, logger);
        if (typeof value !== 'function') return value;
        if (!methods.has(value)) methods.set(value, value.bind(logger));
        return methods.get(value);
      }
      const facade = new Proxy({} as Logger, {
        get(target, key, receiver) {
          return Object.hasOwn(target, key)
            ? Reflect.get(target, key, receiver)
            : visible(key);
        },
        set(target, key, value: unknown, receiver) {
          return Object.hasOwn(target, key)
            ? Reflect.set(target, key, value, receiver)
            : Reflect.set(logger, key, value, logger);
        },
        has: (target, key) => key in target || key in logger,
        ownKeys: (target) => [
          ...new Set([...Reflect.ownKeys(logger), ...Reflect.ownKeys(target)]),
        ],
        getOwnPropertyDescriptor(target, key) {
          const own = Reflect.getOwnPropertyDescriptor(target, key);
          if (own) return own;
          const descriptor = Object.getOwnPropertyDescriptor(logger, key);
          // Accessor-backed methods let descriptor-based spies restore live
          // forwarding rather than pinning a snapshot of the source method.
          return (
            descriptor && {
              configurable: true,
              enumerable: descriptor.enumerable,
              get: () => visible(key),
              ...((
                'writable' in descriptor ? descriptor.writable : descriptor.set
              )
                ? {
                    set: (value: unknown) => {
                      Reflect.set(logger, key, value, logger);
                    },
                  }
                : {}),
            }
          );
        },
        defineProperty: (target, key, descriptor) =>
          Reflect.defineProperty(target, key, descriptor),
        deleteProperty: (target, key) => Reflect.deleteProperty(target, key),
        preventExtensions: () => false,
      });
      decorated.set(logger, facade);
      decorated.set(facade, facade);
      return facade;
    },
  };
}
