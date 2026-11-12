import { AsyncLocalStorage } from 'node:async_hooks';

type WaitUntil = (task: Promise<void>) => void;
type HostedRequest = Request & { waitUntil?: WaitUntil };

const requestLifetime = new AsyncLocalStorage<WaitUntil | undefined>();

export function withRequestLifetime<T>(
  request: HostedRequest,
  run: () => T
): T {
  const waitUntil =
    typeof request.waitUntil === 'function'
      ? request.waitUntil.bind(request)
      : undefined;
  return requestLifetime.run(waitUntil, run);
}

export function retainRequestTask(run: () => Promise<void>): boolean {
  const waitUntil = requestLifetime.getStore();
  if (!waitUntil) return false;

  let retained = false;
  const task = Promise.resolve().then(() => (retained ? run() : undefined));
  try {
    waitUntil(task);
    retained = true;
  } catch {
    // The scheduled callback only starts after successful registration.
  }
  return retained;
}
