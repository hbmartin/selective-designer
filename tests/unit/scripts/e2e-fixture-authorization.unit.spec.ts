import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waitForE2EFixtureAuthorization } from '@tests/support/e2e-fixture-authorization';

class Channel extends EventEmitter {
  connected = true;
  send = vi.fn((_message: unknown, callback: (error: Error | null) => void) =>
    callback(null)
  );
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('announces readiness with handlers installed and permits resources only after authorization', async () => {
  const channel = new Channel();
  const acquire = vi.fn();
  const waiting = waitForE2EFixtureAuthorization(channel).then(acquire);
  expect(channel.send).toHaveBeenCalledWith(
    { type: 'authorization-ready' },
    expect.any(Function)
  );
  channel.emit('message', { type: 'ready' });
  await Promise.resolve();
  expect(acquire).not.toHaveBeenCalled();
  channel.emit('message', { type: 'authorize' });
  await waiting;
  expect(acquire).toHaveBeenCalledOnce();
  expect(channel.listenerCount('message')).toBe(0);
  expect(channel.listenerCount('disconnect')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['disconnect', 'timeout', 'send', 'throw', 'closed'])(
  'rejects %s without acquiring fixture resources',
  async (mode) => {
    const channel = new Channel();
    const failure = new Error('IPC transport failed');
    if (mode === 'send')
      channel.send.mockImplementation((_message, callback) =>
        callback(failure)
      );
    if (mode === 'throw')
      channel.send.mockImplementation(() => {
        throw failure;
      });
    if (mode === 'closed') channel.connected = false;
    const waiting = waitForE2EFixtureAuthorization(channel);
    await Promise.all([
      expect(waiting).rejects.toThrow(
        mode === 'send' || mode === 'throw' ? failure.message : /authorization/
      ),
      (async () => {
        if (mode === 'disconnect') channel.emit('disconnect');
        if (mode === 'timeout') await vi.advanceTimersByTimeAsync(5000);
      })(),
    ]);
    expect(channel.listenerCount('message')).toBe(0);
    expect(channel.listenerCount('disconnect')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  }
);
