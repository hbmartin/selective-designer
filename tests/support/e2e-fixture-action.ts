import { describeE2EFailure } from '../server/e2e-terminal';

/** IPC actions always report an outcome; rejected work is never a checkpoint. */
export async function replyToE2EFixtureAction(
  action: () => Promise<unknown>,
  success: string,
  failure: string,
  send: (message: { type: string; error?: string }) => unknown = (message) =>
    process.send?.(message)
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
