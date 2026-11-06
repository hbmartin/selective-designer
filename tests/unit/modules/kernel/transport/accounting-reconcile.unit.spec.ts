import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getAccountingConfig,
  handleAccountingReconcile,
} from '@/modules/kernel/backend';

describe('accounting cron authority', () => {
  const secret = 'synthetic-cron-secret-for-local-tests';
  it.each([undefined, '', 'Bearer wrong', secret])(
    'rejects invalid authorization %s',
    async (authorization) => {
      const start = vi.fn(async () => {});
      const request = new Request(
        'https://app.test/api/internal/accounting/reconcile',
        { headers: authorization === undefined ? {} : { authorization } }
      );
      expect(
        (await handleAccountingReconcile(request, { secret, start })).status
      ).toBe(401);
      expect(start).not.toHaveBeenCalled();
    }
  );
  it('fails closed when the server secret is absent', async () => {
    const start = vi.fn(async () => {});
    expect(
      (
        await handleAccountingReconcile(
          new Request('https://app.test', {
            headers: { authorization: 'Bearer ' },
          }),
          { secret: undefined, start }
        )
      ).status
    ).toBe(401);
  });
  it('dispatches valid authenticated requests', async () => {
    const start = vi.fn(async () => {});
    const response = await handleAccountingReconcile(
      new Request('https://app.test', {
        headers: { authorization: `Bearer ${secret}` },
      }),
      { secret, start }
    );
    expect(response.status).toBe(202);
    expect(start).toHaveBeenCalledOnce();
  });
});

describe('production cron configuration', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([undefined, 'local-accounting-cron-secret-for-development'])(
    'rejects missing or documented local production credentials',
    (secret) => {
      vi.stubEnv('VERCEL_ENV', 'production');
      vi.stubEnv('CRON_SECRET', secret);
      expect(() => getAccountingConfig()).toThrow('CRON_SECRET');
    }
  );
  it('accepts configured production authority', () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('CRON_SECRET', 'synthetic-production-cron-secret-for-tests');
    expect(getAccountingConfig().cronSecret).toBe(
      'synthetic-production-cron-secret-for-tests'
    );
  });
  it('rejects placeholder and absent secrets outside Vercel in a production runtime', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', undefined);
    for (const secret of [
      undefined,
      'local-accounting-cron-secret-for-development',
    ]) {
      vi.stubEnv('CRON_SECRET', secret);
      expect(() => getAccountingConfig()).toThrow('CRON_SECRET');
    }
  });
  it('allows a disabled preview endpoint but rejects the public placeholder', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('CRON_SECRET', undefined);
    expect(getAccountingConfig()).toEqual({ cronSecret: undefined });
    vi.stubEnv('CRON_SECRET', 'local-accounting-cron-secret-for-development');
    expect(() => getAccountingConfig()).toThrow('CRON_SECRET');
  });
});
