import { beforeDeadline } from '@tests/support/promise-deadline';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => vi.useRealTimers());

it('rejects with the original error when the timeout message builder throws', async () => {
  const pending = Promise.withResolvers<void>();
  const failure = new Error('Unable to build timeout message');
  const deadline = beforeDeadline(
    pending.promise,
    performance.now() + 50,
    () => {
      throw failure;
    }
  );
  await Promise.all([
    expect(deadline).rejects.toBe(failure),
    vi.advanceTimersByTimeAsync(50),
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it('evaluates the timeout message at expiry with the latest output', async () => {
  const pending = Promise.withResolvers<void>();
  let output = 'initial';
  const message = vi.fn(() => `Captured: ${output}`);
  const deadline = beforeDeadline(
    pending.promise,
    performance.now() + 50,
    message
  );
  expect(message).not.toHaveBeenCalled();
  output = 'latest';
  await Promise.all([
    expect(deadline).rejects.toThrow('Captured: latest'),
    vi.advanceTimersByTimeAsync(50),
  ]);
  expect(message).toHaveBeenCalledOnce();
});

it('clears the timer without building a message when work completes first', async () => {
  const message = vi.fn(() => 'Work timed out');
  await expect(
    beforeDeadline(Promise.resolve('ready'), performance.now() + 50, message)
  ).resolves.toBe('ready');
  expect(vi.getTimerCount()).toBe(0);
  expect(message).not.toHaveBeenCalled();
});
