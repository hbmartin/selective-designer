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
