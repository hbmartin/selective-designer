/** Cache a module promise, but let later steps recover after a failed load. */
export function lazyModule<T>(load: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
