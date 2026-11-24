import { describeE2EFailure } from '../server/e2e-terminal';

export function sendE2EFixtureMessage(message: {
  type: string;
  [key: string]: unknown;
}) {
  return new Promise<void>((resolve, reject) => {
    if (!process.send) {
      reject(new Error('E2E fixture IPC is unavailable'));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

/** Passive notifications never add an IPC wait to cleanup or terminal deadlines. */
export function notifyE2EFixture(message: {
  type: string;
  [key: string]: unknown;
}) {
  void sendE2EFixtureMessage(message).catch((error: unknown) => {
    console.warn('E2E fixture notification transport diagnostic:', error);
  });
}

/** IPC actions always report an outcome; rejected work is never a checkpoint. */
export async function replyToE2EFixtureAction(
  action: () => Promise<unknown>,
  success: string,
  failure: string,
  send: (message: {
    type: string;
    error?: string;
  }) => unknown = sendE2EFixtureMessage
) {
  let outcome: { type: string; error?: string };
  try {
    await action();
    outcome = { type: success };
  } catch (error) {
    outcome = { type: failure, error: describeE2EFailure(error) };
  }
  try {
    await send(outcome);
  } catch (error) {
    console.warn('E2E fixture response transport diagnostic:', error);
  }
}
