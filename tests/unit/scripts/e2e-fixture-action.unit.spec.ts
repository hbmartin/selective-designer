import { afterEach, expect, it, vi } from 'vitest';
import {
  notifyE2EFixture,
  replyToE2EFixtureAction,
} from '@tests/support/e2e-fixture-action';

const sendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
afterEach(() => {
  if (sendDescriptor) Object.defineProperty(process, 'send', sendDescriptor);
  else Reflect.deleteProperty(process, 'send');
  vi.restoreAllMocks();
});

it.each(['restart', 'abandoned-change'])(
  'reports rejected %s actions without a success checkpoint',
  async (name) => {
    const send = vi.fn();
    const error = new Error('Controlled action rejection');
    await replyToE2EFixtureAction(
      async () => {
        throw error;
      },
      `${name}-delivered`,
      `${name}-failed`,
      send
    );
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: `${name}-failed`,
      error: error.message,
    });
    await replyToE2EFixtureAction(
      async () => {},
      `${name}-delivered`,
      `${name}-failed`,
      send
    );
    expect(send).toHaveBeenLastCalledWith({ type: `${name}-delivered` });
  }
);
it('observes response transport failure separately from the action outcome', async () => {
  const failure = new Error('Disconnected response channel');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await replyToE2EFixtureAction(
      async () => {},
      'delivered',
      'failed',
      async () => {
        throw failure;
      }
    );
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'E2E fixture response transport diagnostic:',
      failure
    );
  } finally {
    warning.mockRestore();
  }
});

it.each(['callback', 'throw', 'missing'])(
  'observes default IPC transport failure through %s without sending a second outcome',
  async (kind) => {
    const failure = new Error('IPC channel closed');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn(
      (_message: unknown, callback: (error: Error | null) => void) => {
        if (kind === 'throw') throw failure;
        queueMicrotask(() => callback(failure));
        return false;
      }
    );
    if (kind === 'missing') Reflect.deleteProperty(process, 'send');
    else
      Object.defineProperty(process, 'send', {
        configurable: true,
        value: send,
      });
    await replyToE2EFixtureAction(async () => {}, 'delivered', 'failed');
    expect(warning).toHaveBeenCalledOnce();
    if (kind !== 'missing') {
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]![0]).toEqual({ type: 'delivered' });
      expect(warning).toHaveBeenCalledWith(
        'E2E fixture response transport diagnostic:',
        failure
      );
    }
  }
);

it('waits for default IPC callback completion instead of its boolean return', async () => {
  const delivered = Promise.withResolvers<void>();
  let finish!: (error: Error | null) => void;
  Object.defineProperty(process, 'send', {
    configurable: true,
    value: (_message: unknown, callback: typeof finish) => {
      finish = callback;
      return false;
    },
  });
  const action = replyToE2EFixtureAction(async () => {}, 'done', 'failed').then(
    () => delivered.resolve()
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  let settled = false;
  void delivered.promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish(null);
  await action;
});

it.each(['callback', 'throw', 'missing'])(
  'observes passive %s failure once without changing exit status',
  async (kind) => {
    const previous = process.exitCode;
    const failure = new Error('Notification channel closed');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn(
      (_message: unknown, callback: (error: Error | null) => void) => {
        if (kind === 'throw') throw failure;
        queueMicrotask(() => callback(failure));
        return false;
      }
    );
    if (kind === 'missing') Reflect.deleteProperty(process, 'send');
    else
      Object.defineProperty(process, 'send', {
        configurable: true,
        value: send,
      });
    expect(notifyE2EFixture({ type: 'flush-held' })).toBeUndefined();
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(previous);
    expect(send).toHaveBeenCalledTimes(kind === 'missing' ? 0 : 1);
  }
);
it('does not await a stalled passive notification callback', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let callback!: (error: Error | null) => void;
  Object.defineProperty(process, 'send', {
    configurable: true,
    value: (_message: unknown, done: typeof callback) => {
      callback = done;
      return false;
    },
  });
  expect(notifyE2EFixture({ type: 'cleanup-gate' })).toBeUndefined();
  expect(callback).toBeTypeOf('function');
  expect(warning).not.toHaveBeenCalled();
  callback(new Error('Late callback failure'));
  await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
});
