import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sleep } from 'workflow';

// Pinned SDK contract: the real sleep implementation owns suspension and completion.
// This harness supplies event delivery, not a replacement sleep or rejection policy.
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('workflow'));
const sdkRoot = path.dirname(sdkRequire.resolve('@workflow/core/runtime'));
const { createSleep } = await import(
  pathToFileURL(path.join(sdkRoot, 'workflow/sleep.js')).href
);
const sleepBinding = Symbol.for('WORKFLOW_SLEEP');
const originalSleepBinding = Object.getOwnPropertyDescriptor(
  globalThis,
  sleepBinding
);

type WaitEvent = {
  eventType: 'wait_created' | 'wait_completed';
  correlationId: string;
  eventData: { resumeAt: Date };
  createdAt: Date;
};

describe('durable sleep against the pinned SDK', () => {
  afterEach(() => {
    try {
      if (originalSleepBinding)
        Object.defineProperty(globalThis, sleepBinding, originalSleepBinding);
      else Reflect.deleteProperty(globalThis, sleepBinding);
    } finally {
      vi.useRealTimers();
    }
  });

  it('suspends with an unresolved wait and resolves on its matching completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
    let consume: (event?: WaitEvent) => unknown = () => {
      throw new Error('SDK did not subscribe to wait events');
    };
    const ctx = {
      generateUlid: () => 'sleep_contract',
      invocationsQueue: new Map<string, { resumeAt: Date }>(),
      eventsConsumer: {
        eventIndex: 1,
        subscribe: (subscriber: typeof consume) => {
          consume = subscriber;
        },
      },
      promiseQueue: Promise.resolve(),
      pendingDeliveries: 0,
      suspensionGeneration: 0,
      globalThis: {},
      onWorkflowError: vi.fn(),
    };
    const settled = vi.fn();
    Object.defineProperty(globalThis, sleepBinding, {
      configurable: true,
      value: createSleep(ctx),
    });
    const waiting = sleep(2000);
    const observed = waiting.then(
      () => settled('resolved'),
      () => settled('rejected')
    );
    consume();
    await vi.runOnlyPendingTimersAsync();

    expect(settled).not.toHaveBeenCalled();
    expect(ctx.onWorkflowError).toHaveBeenCalledOnce();
    expect(ctx.onWorkflowError.mock.calls[0]![0].constructor.name).toBe(
      'WorkflowSuspension'
    );
    const correlationId = 'wait_sleep_contract';
    const resumeAt = new Date('2026-11-08T12:00:02Z');
    expect(ctx.invocationsQueue.get(correlationId)).toMatchObject({ resumeAt });

    consume({
      eventType: 'wait_created',
      correlationId,
      eventData: { resumeAt },
      createdAt: new Date(),
    });
    consume({
      eventType: 'wait_completed',
      correlationId,
      eventData: { resumeAt },
      createdAt: resumeAt,
    });
    await expect(waiting).resolves.toBeUndefined();
    await observed;
    expect(settled).toHaveBeenCalledExactlyOnceWith('resolved');
    expect(ctx.invocationsQueue.size).toBe(0);
  });
});
