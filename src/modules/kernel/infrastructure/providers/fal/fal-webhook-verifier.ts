import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import type { Clock } from '@/modules/kernel/application/ports/clock';
import { AppError } from '@/modules/kernel/domain/errors/app-error';

/**
 * Verifies fal.ai webhook signatures (ED25519 over
 * `requestId\nuserId\ntimestamp\nsha256hex(rawBody)`), per
 * https://fal.ai/docs/documentation/model-apis/inference/webhooks.
 */
export const FAL_JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json';
const TIMESTAMP_TOLERANCE_SECONDS = 300;
const JWKS_CACHE_MS = 12 * 60 * 60 * 1000;

const jwksSchema = z.object({
  keys: z.array(z.object({ x: z.string().min(1) }).passthrough()),
});

export type FalWebhookVerification =
  | { type: 'fal_webhook_verified'; requestId: string; rawBody: string }
  | {
      type: 'fal_webhook_rejected';
      reason:
        | 'missing_headers'
        | 'stale_timestamp'
        | 'bad_signature_encoding'
        | 'signature_mismatch';
    };

type FetchLike = (input: string) => Promise<Response>;

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^(?:[0-9a-f]{2})+$/iu.test(hex)) return undefined;
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const sha256Hex = async (text: string) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const jwksError = (cause: unknown) =>
  new AppError({
    code: 'FAL_JWKS_UNAVAILABLE',
    category: 'system',
    status: 503,
    message: 'Could not load fal webhook signing keys',
    cause,
  });

export const createFalWebhookVerifier = ({
  clock,
  fetchJwks = (url) => fetch(url),
  jwksUrl = FAL_JWKS_URL,
}: {
  clock: Clock;
  fetchJwks?: FetchLike;
  jwksUrl?: string;
}) => {
  let cachedKeys: { keys: CryptoKey[]; loadedAt: number } | undefined;

  const loadKeys = async (): Promise<BoxedResult<CryptoKey[], AppError>> => {
    const nowMs = clock.now().getTime();
    if (cachedKeys && nowMs - cachedKeys.loadedAt < JWKS_CACHE_MS) {
      return Result.Ok(cachedKeys.keys);
    }
    try {
      const response = await fetchJwks(jwksUrl);
      if (!response.ok) {
        return Result.Error(jwksError(`JWKS status ${response.status}`));
      }
      const parsed = jwksSchema.safeParse(await response.json());
      if (!parsed.success) return Result.Error(jwksError(parsed.error));
      const keys = await Promise.all(
        parsed.data.keys.map((key) =>
          crypto.subtle.importKey(
            'jwk',
            { kty: 'OKP', crv: 'Ed25519', x: key.x },
            { name: 'Ed25519' },
            false,
            ['verify']
          )
        )
      );
      cachedKeys = { keys, loadedAt: nowMs };
      return Result.Ok(keys);
    } catch (error) {
      return Result.Error(jwksError(error));
    }
  };

  return {
    async verify(input: {
      headers: Headers;
      rawBody: string;
    }): Promise<BoxedResult<FalWebhookVerification, AppError>> {
      const requestId = input.headers.get('x-fal-webhook-request-id');
      const userId = input.headers.get('x-fal-webhook-user-id');
      const timestamp = input.headers.get('x-fal-webhook-timestamp');
      const signatureHex = input.headers.get('x-fal-webhook-signature');
      if (!requestId || !userId || !timestamp || !signatureHex) {
        return Result.Ok({
          type: 'fal_webhook_rejected',
          reason: 'missing_headers',
        });
      }

      const timestampSeconds = Number(timestamp);
      const nowSeconds = clock.now().getTime() / 1000;
      if (
        !Number.isFinite(timestampSeconds) ||
        Math.abs(nowSeconds - timestampSeconds) > TIMESTAMP_TOLERANCE_SECONDS
      ) {
        return Result.Ok({
          type: 'fal_webhook_rejected',
          reason: 'stale_timestamp',
        });
      }

      const signature = hexToBytes(signatureHex);
      if (!signature) {
        return Result.Ok({
          type: 'fal_webhook_rejected',
          reason: 'bad_signature_encoding',
        });
      }

      const keys = await loadKeys();
      if (keys.isError()) return Result.Error(keys.getError());

      const message = new TextEncoder().encode(
        [requestId, userId, timestamp, await sha256Hex(input.rawBody)].join(
          '\n'
        )
      );
      for (const key of keys.get()) {
        // oxlint-disable-next-line no-await-in-loop -- try keys in order; usually one.
        if (await crypto.subtle.verify('Ed25519', key, signature, message)) {
          return Result.Ok({
            type: 'fal_webhook_verified',
            requestId,
            rawBody: input.rawBody,
          });
        }
      }
      return Result.Ok({
        type: 'fal_webhook_rejected',
        reason: 'signature_mismatch',
      });
    },
  };
};

export type FalWebhookVerifier = ReturnType<typeof createFalWebhookVerifier>;
