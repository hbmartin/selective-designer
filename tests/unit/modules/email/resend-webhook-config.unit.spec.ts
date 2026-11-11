import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('RESEND_API_KEY', undefined);
  vi.stubEnv('RESEND_WEBHOOK_SECRET', undefined);
  vi.stubEnv('EMAIL_FROM', undefined);
  vi.stubEnv('EMAIL_SERVER', undefined);
  vi.stubEnv('EMAIL_DELIVERY_DISABLED', 'true');
});

afterEach(() => vi.unstubAllEnvs());

it('returns 404 without reading the body if no callback secret is configured', async () => {
  const { handleResendWebhookRequest } =
    await import('@/modules/email/backend');
  const request = new Request('http://localhost/api/webhooks/resend', {
    method: 'POST',
    body: 'unread',
  });
  expect((await handleResendWebhookRequest(request)).status).toBe(404);
  expect(request.bodyUsed).toBe(false);
});

it('verifies signed callbacks with sending disabled and no delivery credentials', async () => {
  const key = randomBytes(32);
  vi.stubEnv('RESEND_WEBHOOK_SECRET', `whsec_${key.toString('base64')}`);
  const { handleResendWebhookRequest } =
    await import('@/modules/email/backend');
  const createdAt = new Date();
  const payload = JSON.stringify({
    type: 'domain.updated',
    created_at: createdAt.toISOString(),
    data: {},
  });
  const timestamp = Math.floor(createdAt.getTime() / 1000);
  const id = globalThis.crypto.randomUUID();
  const signature = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest('base64');
  const request = new Request('http://localhost/api/webhooks/resend', {
    method: 'POST',
    headers: {
      'svix-id': id,
      'svix-timestamp': String(timestamp),
      'svix-signature': `v1,${signature}`,
    },
    body: payload,
  });
  expect(await (await handleResendWebhookRequest(request)).json()).toEqual({
    ok: true,
    ignored: true,
  });
});
