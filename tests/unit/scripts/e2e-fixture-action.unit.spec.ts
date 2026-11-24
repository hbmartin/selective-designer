import { expect, it, vi } from 'vitest';
import { replyToE2EFixtureAction } from '@tests/support/e2e-fixture-action';

it.each(['restart', 'abandoned-change'])(
  'reports rejected %s actions without a success checkpoint',
  async (name) => {
    const send = vi.fn();
    const error = new Error('Controlled action rejection');
    await replyToE2EFixtureAction(
      async () => {
        throw error;
      },
      `${name}-delivered`,
      `${name}-failed`,
      send
    );
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: `${name}-failed`,
      error: error.message,
    });
    await replyToE2EFixtureAction(
      async () => {},
      `${name}-delivered`,
      `${name}-failed`,
      send
    );
    expect(send).toHaveBeenLastCalledWith({ type: `${name}-delivered` });
  }
);
it('observes response transport failure separately from the action outcome', async () => {
  const failure = new Error('Disconnected response channel');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await replyToE2EFixtureAction(
      async () => {},
      'delivered',
      'failed',
      async () => {
        throw failure;
      }
    );
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'E2E fixture response transport diagnostic:',
      failure
    );
  } finally {
    warning.mockRestore();
  }
});
