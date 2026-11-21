/** Keep every launched operation observed and drained before its clients can close. */
export async function runBlockedSubmissions<T>({
  block,
  submissions,
  observe,
}: {
  block: (announceLock: () => void, release: Promise<void>) => Promise<unknown>;
  submissions: readonly (() => Promise<T>)[];
  observe: () => Promise<void>;
}): Promise<T[]> {
  let unlock!: () => void;
  let announceLock!: () => void;
  const release = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    announceLock = resolve;
  });
  const blocker = Promise.resolve().then(() => block(announceLock, release));
  const blockerOutcome = blocker.then(
    () => ({ status: 'fulfilled' as const }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  );
  const pending: Promise<T>[] = [];
  let primaryFailure: { error: unknown } | undefined;
  try {
    const ready = await Promise.race([
      locked.then(() => ({ type: 'locked' as const })),
      blockerOutcome.then((outcome) => ({ type: 'settled' as const, outcome })),
    ]);
    if (ready.type === 'settled') {
      if (ready.outcome.status === 'rejected') throw ready.outcome.reason;
      throw new Error('Lock holder completed before announcing readiness');
    }
    for (const submit of submissions) {
      const task = Promise.resolve().then(submit);
      void task.catch(() => undefined);
      pending.push(task);
    }
    await observe();
  } catch (error) {
    primaryFailure = { error };
  } finally {
    unlock();
  }
  const [blocked, completed] = await Promise.all([
    blockerOutcome,
    Promise.allSettled(pending),
  ]);
  if (primaryFailure) throw primaryFailure.error;
  if (blocked.status === 'rejected') throw blocked.reason;
  return completed.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });
}
