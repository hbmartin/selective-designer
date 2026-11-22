/** One absolute budget, including work already spent before joining a promise. */
export async function beforeDeadline<T>(
  pending: Promise<T>,
  deadline: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(message)),
      Math.max(0, deadline - performance.now())
    );
  });
  try {
    // Promise.race observes pending even when the deadline wins.
    return await Promise.race([pending, expired]);
  } finally {
    clearTimeout(timer);
  }
}
