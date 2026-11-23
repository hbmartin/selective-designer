/** One absolute budget, including work already spent before joining a promise. */
export async function beforeDeadline<T>(
  pending: Promise<T>,
  deadline: number,
  /** A callback builds the message at expiry, e.g. to include captured output. */
  message: string | (() => string)
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
  }).then(() => {
    throw new Error(typeof message === 'function' ? message() : message);
  });
  try {
    // Promise.race observes pending even when the deadline wins.
    return await Promise.race([pending, expired]);
  } finally {
    clearTimeout(timer);
  }
}
