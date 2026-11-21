import { expect, it, vi } from 'vitest';
import { runBlockedSubmissions } from '@tests/support/blocked-submissions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const hold = async (announce: () => void, release: Promise<void>) => {
  announce();
  await release;
};

it('fails before readiness without starting submissions or observation', async () => {
  const failure = new Error('lock acquisition failed');
  const submit = vi.fn(async () => 1);
  const observe = vi.fn(async () => {});
  await expect(
    runBlockedSubmissions({
      block: async () => {
        throw failure;
      },
      submissions: [submit],
      observe,
    })
  ).rejects.toBe(failure);
  expect(submit).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
});
it('rejects a lock holder that ends before announcing readiness', async () => {
  await expect(
    runBlockedSubmissions({
      block: async () => {},
      submissions: [],
      observe: async () => {},
    })
  ).rejects.toThrow('before announcing readiness');
});
it('propagates a blocker failure after release and drains submissions', async () => {
  const failure = new Error('commit failed');
  const drained = vi.fn();
  await expect(
    runBlockedSubmissions({
      block: async (...args) => {
        await hold(...args);
        throw failure;
      },
      submissions: [
        async () => {
          drained();
          return 1;
        },
      ],
      observe: async () => {},
    })
  ).rejects.toBe(failure);
  expect(drained).toHaveBeenCalledOnce();
});
it('keeps the observation failure ahead of blocker and submission failures', async () => {
  const failure = new Error('poll failed');
  let released = false;
  await expect(
    runBlockedSubmissions({
      block: async (...args) => {
        await hold(...args);
        released = true;
        throw new Error('commit failed');
      },
      submissions: [
        async () => {
          throw new Error('submission failed');
        },
      ],
      observe: async () => {
        throw failure;
      },
    })
  ).rejects.toBe(failure);
  expect(released).toBe(true);
});
it('drains a delayed sibling after an earlier submission rejects', async () => {
  const failure = new Error('first submission failed');
  const failed = deferred<void>();
  const later = deferred<number>();
  let settled = false;
  const result = runBlockedSubmissions({
    block: hold,
    submissions: [
      async () => {
        failed.resolve();
        throw failure;
      },
      () => later.promise,
    ],
    observe: async () => {},
  });
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await failed.promise;
  expect(settled).toBe(false);
  later.resolve(2);
  await expect(result).rejects.toBe(failure);
});
it('reports submission failures in launch order after all operations settle', async () => {
  const first = deferred<number>();
  const later = deferred<void>();
  const failure = new Error('first in launch order');
  const result = runBlockedSubmissions({
    block: hold,
    submissions: [
      () => first.promise,
      async () => {
        later.resolve();
        throw new Error('later failure');
      },
    ],
    observe: async () => {},
  });
  void result.catch(() => undefined);
  await later.promise;
  first.resolve(1);
  await expect(result).rejects.toThrow('later failure');
  await expect(
    runBlockedSubmissions({
      block: hold,
      submissions: [
        async () => {
          throw failure;
        },
        async () => {
          throw new Error('later failure');
        },
      ],
      observe: async () => {},
    })
  ).rejects.toBe(failure);
});
