import { expect, it, vi } from 'vitest';
import { createLogger } from 'vite';
import { createE2ERestartCancellation } from '@tests/server/e2e-restart-cancellation';

it('suppresses only exact owned shutdown cancellation diagnostics, including ANSI wrapping', () => {
  let stopped = false;
  const cancellation = createE2ERestartCancellation(() => stopped);
  const logger = createLogger('silent');
  const error = vi.spyOn(logger, 'error');
  const facade = cancellation.decorate(logger);
  const failure = cancellation.error();
  expect(failure.message).toBe('E2E restart cancelled before starting');
  facade.error(String(failure));
  expect(error).toHaveBeenCalledOnce();
  stopped = true;
  facade.error(`\u001b[31m${String(failure)}\u001b[39m`);
  expect(error).toHaveBeenCalledOnce();
  const options = { timestamp: true, error: new Error('genuine') };
  facade.error('Error: E2E restart cancelled before starting', options);
  facade.error(`prefix ${String(failure)}`);
  expect(error).toHaveBeenCalledTimes(3);
  expect(error).toHaveBeenNthCalledWith(
    2,
    'Error: E2E restart cancelled before starting',
    options
  );
  expect(cancellation.decorate(facade)).toBe(facade);
  expect(cancellation.decorate(logger)).toBe(facade);
});

it('forwards live custom logger accessors and method receivers', () => {
  const logger = createLogger('silent');
  const info = vi.spyOn(logger, 'info').mockImplementation(function (
    this: typeof logger
  ) {
    expect(this).toBe(logger);
  });
  const facade = createE2ERestartCancellation(() => true).decorate(logger);
  expect(facade.hasWarned).toBe(false);
  logger.hasWarned = true;
  expect(facade.hasWarned).toBe(true);
  facade.hasWarned = false;
  expect(logger.hasWarned).toBe(false);
  facade.info('forwarded', { timestamp: true });
  expect(info).toHaveBeenCalledWith('forwarded', { timestamp: true });
  expect(Reflect.ownKeys(facade)).toEqual(Reflect.ownKeys(logger));
  expect('hasErrorLogged' in facade).toBe(true);
});

it('forwards runtime non-string inputs and suppresses only owned cancellation objects', () => {
  let stopped = false;
  const cancellation = createE2ERestartCancellation(() => stopped);
  const logger = createLogger('silent');
  const error = vi.spyOn(logger, 'error');
  const facade = cancellation.decorate(logger);
  const owned = cancellation.error();
  const runtimeError = facade.error as (
    value: unknown,
    options?: object
  ) => void;
  runtimeError(owned);
  stopped = true;
  runtimeError(owned);
  const unrelated = Object.assign(new Error(owned.message), {
    toString: () => String(owned),
  });
  const options = { timestamp: true };
  runtimeError(unrelated, options);
  runtimeError(null);
  runtimeError({ message: 'watcher error' });
  expect(error).toHaveBeenCalledTimes(4);
  expect(error).toHaveBeenNthCalledWith(2, unrelated, options);
  expect(error).toHaveBeenNthCalledWith(3, null, undefined);
});

it('supports facade spies with filtered call-through and live lookup after restoration', () => {
  const cancellation = createE2ERestartCancellation(() => true);
  const logger = createLogger('silent');
  const seen: unknown[] = [];
  logger.error = function (message) {
    expect(this).toBe(logger);
    seen.push(message);
  };
  const facade = cancellation.decorate(logger);
  const spy = vi.spyOn(facade, 'error');
  facade.error(String(cancellation.error()));
  facade.error('genuine');
  expect(spy).toHaveBeenCalledTimes(2);
  expect(seen).toEqual(['genuine']);
  spy.mockImplementation(() => {});
  facade.error('mocked');
  expect(seen).toEqual(['genuine']);
  spy.mockRestore();
  const replacement = vi.fn();
  logger.error = replacement;
  facade.error('replacement');
  facade.error(String(cancellation.error()));
  expect(replacement).toHaveBeenCalledExactlyOnceWith('replacement', undefined);

  const info = vi.spyOn(facade, 'info');
  facade.info('first');
  expect(info).toHaveBeenCalledOnce();
  info.mockRestore();
  const nextInfo = vi.fn();
  logger.info = nextInfo;
  facade.info('live');
  expect(nextInfo).toHaveBeenCalledWith('live');
});

it('honors explicit local descriptors and reveals live forwarding after deletion', () => {
  const logger = createLogger('silent');
  const facade = createE2ERestartCancellation(() => true).decorate(logger);
  const original = logger.error;
  const override = vi.fn();
  Object.defineProperty(facade, 'error', {
    value: override,
    configurable: true,
  });
  facade.error('local');
  expect(override).toHaveBeenCalledWith('local');
  expect(logger.error).toBe(original);
  Reflect.deleteProperty(facade, 'error');
  expect(facade.error).not.toBe(override);
  const key = Symbol('local');
  Object.defineProperty(facade, key, { value: 42, configurable: false });
  expect(Reflect.get(facade, key)).toBe(42);
  expect(Reflect.ownKeys(facade)).toContain(key);
  expect(Reflect.deleteProperty(facade, key)).toBe(false);
  expect(Reflect.preventExtensions(facade)).toBe(false);
});
