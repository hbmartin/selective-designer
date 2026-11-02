import { errorValue, okValue } from '@tests/support/result';
import { describe, expect, it, vi } from 'vitest';

import { createFalWebhookVerifier } from '@/modules/kernel/infrastructure/providers/fal/fal-webhook-verifier';

const now = new Date('2026-11-02T12:00:00.000Z');
const clock = { now: () => now };
const timestamp = String(Math.floor(now.getTime() / 1000));

const toHex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const sha256Hex = async (text: string) =>
  toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

const makeKeyPair = async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, x: jwk.x ?? '' };
};

const signedHeaders = async (input: {
  privateKey: CryptoKey;
  rawBody: string;
  requestId?: string;
  userId?: string;
  timestamp?: string;
}) => {
  const requestId = input.requestId ?? 'req-1';
  const userId = input.userId ?? 'user-1';
  const ts = input.timestamp ?? timestamp;
  const message = [requestId, userId, ts, await sha256Hex(input.rawBody)].join(
    '\n'
  );
  const signature = await crypto.subtle.sign(
    'Ed25519',
    input.privateKey,
    new TextEncoder().encode(message)
  );
  return new Headers({
    'x-fal-webhook-request-id': requestId,
    'x-fal-webhook-user-id': userId,
    'x-fal-webhook-timestamp': ts,
    'x-fal-webhook-signature': toHex(signature),
  });
};

const jwksFetch = (xs: string[]) =>
  vi.fn(async () => Response.json({ keys: xs.map((x) => ({ x })) }));

describe('fal webhook verifier', () => {
  it('accepts a body signed by any published key', async () => {
    const other = await makeKeyPair();
    const signer = await makeKeyPair();
    const fetchJwks = jwksFetch([other.x, signer.x]);
    const verifier = createFalWebhookVerifier({ clock, fetchJwks });
    const rawBody = JSON.stringify({ request_id: 'req-1', status: 'OK' });

    const result = await verifier.verify({
      headers: await signedHeaders({ privateKey: signer.privateKey, rawBody }),
      rawBody,
    });

    expect(okValue(result)).toEqual({
      type: 'fal_webhook_verified',
      requestId: 'req-1',
      rawBody,
    });

    await verifier.verify({
      headers: await signedHeaders({ privateKey: signer.privateKey, rawBody }),
      rawBody,
    });
    expect(fetchJwks).toHaveBeenCalledOnce();
  });

  it('rejects tampered bodies, stale timestamps and missing headers', async () => {
    const signer = await makeKeyPair();
    const verifier = createFalWebhookVerifier({
      clock,
      fetchJwks: jwksFetch([signer.x]),
    });
    const rawBody = '{"status":"OK"}';
    const headers = await signedHeaders({
      privateKey: signer.privateKey,
      rawBody,
    });

    expect(
      okValue(await verifier.verify({ headers, rawBody: '{"status":"ERROR"}' }))
    ).toEqual({ type: 'fal_webhook_rejected', reason: 'signature_mismatch' });

    const stale = await signedHeaders({
      privateKey: signer.privateKey,
      rawBody,
      timestamp: String(Number(timestamp) - 301),
    });
    expect(okValue(await verifier.verify({ headers: stale, rawBody }))).toEqual(
      {
        type: 'fal_webhook_rejected',
        reason: 'stale_timestamp',
      }
    );

    expect(
      okValue(await verifier.verify({ headers: new Headers(), rawBody }))
    ).toEqual({ type: 'fal_webhook_rejected', reason: 'missing_headers' });
  });

  it('returns a system error when signing keys cannot be loaded', async () => {
    const signer = await makeKeyPair();
    const verifier = createFalWebhookVerifier({
      clock,
      fetchJwks: vi.fn(async () => new Response('nope', { status: 503 })),
    });
    const rawBody = '{}';
    const result = await verifier.verify({
      headers: await signedHeaders({ privateKey: signer.privateKey, rawBody }),
      rawBody,
    });
    expect(errorValue(result).code).toBe('FAL_JWKS_UNAVAILABLE');
  });
});
