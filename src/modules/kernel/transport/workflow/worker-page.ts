/** Deterministic workflow-side slots; a slow step occupies only its own slot. */
export async function runWorkerPage<T>(
  items: readonly T[],
  operation: (item: T) => Promise<boolean>
) {
  let next = 0;
  let completed = 0;
  let failed = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item === undefined) break;
      try {
        // oxlint-disable-next-line no-await-in-loop -- continuously replenish each independent slot.
        if (await operation(item)) completed++;
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));
  return { completed, failed };
}
