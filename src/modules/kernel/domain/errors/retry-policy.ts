/** Never suspend a workflow indefinitely on an external service's instructions. */
export const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

export const isExcessiveRetryDelay = (delay: number) =>
  !Number.isFinite(delay) || delay < 0 || delay > MAX_RETRY_AFTER_MS;
