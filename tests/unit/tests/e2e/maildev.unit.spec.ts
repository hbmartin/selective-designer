/* oxlint-disable simple-import-sort/imports -- Oxfmt owns import ordering. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readLatestOtp } from '@tests/e2e/utils/maildev';

describe('readLatestOtp', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a same-second message when Maildev truncates milliseconds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([
          {
            date: '2026-07-09T23:26:29.000Z',
            subject: 'Your verification code is 123456',
            to: [{ address: 'user@example.com' }],
          },
        ])
      )
    );

    await expect(
      readLatestOtp('user@example.com', {
        afterMs: Date.parse('2026-07-09T23:26:29.207Z'),
        timeoutMs: 50,
      })
    ).resolves.toBe('123456');
  });
});
