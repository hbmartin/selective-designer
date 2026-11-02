import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { match, P } from 'ts-pattern';
import { z } from 'zod';

import {
  EMAIL_PROVIDER_RESEND,
  type EmailStatus,
  type EmailUseCases,
} from '@/modules/email';
import type { Logger } from '@/modules/kernel';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import {
  toEmailProviderMessageId,
  toEmailRecipientList,
  toEmailWebhookEventId,
} from '@/modules/kernel/domain/ids';
import { getClientIp } from '@/platform/http/get-client-ip';
import {
  defaultRateLimiter,
  type RateLimiter,
} from '@/platform/http/rate-limiter';

type VerifyResendWebhookInput = {
  payload: string;
  headers: {
    id: string;
    timestamp: string;
    signature: string;
  };
};

type ResendWebhookVerifier = {
  verify(input: VerifyResendWebhookInput): unknown;
};

type ResendWebhookHandlerDeps = {
  getUseCases: () => EmailUseCases;
  logger?: Pick<Logger, 'warn'>;
  maxBodyBytes?: number;
  verifier: ResendWebhookVerifier;
  /** Trusted reverse-proxy hops in front of the app (see `getClientIp`). */
  trustedProxyDepth?: number;
  /** Per-IP webhook hits allowed per minute before returning HTTP 429. */
  rateLimitPerMinute?: number;
  /** Injectable limiter; defaults to the shared process-wide limiter. */
  rateLimiter?: RateLimiter;
};

const DEFAULT_RESEND_WEBHOOK_MAX_BYTES = 1_000_000;

/**
 * Best-effort per-IP cap on inbound Resend webhook requests, applied BEFORE the
 * (more expensive) Svix signature verification so unsigned floods are shed
 * cheaply. Fail-closed verification and replay dedupe still run afterwards. This
 * limiter is in-memory/per-process; durable cross-instance limits belong at the
 * edge/WAF (see `docs/security-rate-limiting.md`).
 */
const DEFAULT_RESEND_WEBHOOK_RATE_LIMIT_PER_MINUTE = 120;
const RESEND_WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000;

const resendTrackedEmailEventTypes = [
  'email.sent',
  'email.scheduled',
  'email.delivered',
  'email.delivery_delayed',
  'email.complained',
  'email.bounced',
  'email.opened',
  'email.clicked',
  'email.received',
  'email.failed',
  'email.suppressed',
] as const;

const resendEmailStatusByEventType = {
  'email.sent': 'sent',
  'email.scheduled': 'scheduled',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delivery_delayed',
  'email.complained': 'complained',
  'email.bounced': 'bounced',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.received': 'received',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
} satisfies Record<(typeof resendTrackedEmailEventTypes)[number], EmailStatus>;

const resendWebhookBaseEventSchema = z
  .object({
    created_at: z.string(),
    data: z.unknown(),
    type: z.string(),
  })
  .passthrough();

const trackedResendEmailEventSchema = resendWebhookBaseEventSchema.extend({
  data: z
    .object({
      email_id: z.string(),
      subject: z.string(),
      to: z.array(z.string()),
    })
    .passthrough(),
  type: z.enum(resendTrackedEmailEventTypes),
});

type ResendWebhookEvent = z.infer<typeof resendWebhookBaseEventSchema>;
type TrackedResendEmailEvent = z.infer<typeof trackedResendEmailEventSchema>;

const requiredHeader = (headers: Headers, name: string) => {
  const value = headers.get(name);
  if (value) return value;

  throw new AppError({
    code: 'EMAIL_WEBHOOK_MISSING_HEADER',
    category: 'bad_request',
    status: 400,
    message: 'Missing email webhook signature header',
    details: { header: name },
    exposeDetails: true,
  });
};

const payloadTooLargeError = (maxBodyBytes: number) =>
  new AppError({
    code: 'EMAIL_WEBHOOK_PAYLOAD_TOO_LARGE',
    category: 'bad_request',
    status: 413,
    message: 'Email webhook payload is too large',
    details: { maxBytes: maxBodyBytes },
    exposeDetails: true,
  });

const invalidBodyError = (cause: unknown) =>
  new AppError({
    code: 'EMAIL_WEBHOOK_INVALID_BODY',
    category: 'bad_request',
    status: 400,
    message: 'Invalid email webhook request body',
    cause,
  });

const invalidEventError = (cause: unknown) =>
  new AppError({
    code: 'EMAIL_WEBHOOK_INVALID_EVENT',
    category: 'bad_request',
    status: 400,
    message: 'Invalid email webhook event',
    cause,
  });

const invalidTrackedEventError = (cause: unknown) =>
  new AppError({
    code: 'EMAIL_WEBHOOK_INVALID_TRACKED_EVENT',
    category: 'bad_request',
    status: 400,
    message: 'Invalid tracked email webhook event',
    cause,
  });

const normalizeMaxBodyBytes = (maxBodyBytes?: number) =>
  Number.isFinite(maxBodyBytes) &&
  maxBodyBytes !== undefined &&
  maxBodyBytes > 0
    ? maxBodyBytes
    : DEFAULT_RESEND_WEBHOOK_MAX_BYTES;

const decodeChunks = (chunks: Uint8Array[], totalBytes: number) => {
  const payloadBytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    payloadBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(payloadBytes);
};

const readBoundedTextBody = async (request: Request, maxBodyBytes: number) => {
  const contentLengthHeader = request.headers.get('Content-Length');
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      throw payloadTooLargeError(maxBodyBytes);
    }
  }

  if (!request.body) return '';

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    reader = request.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        await reader.cancel();
        throw payloadTooLargeError(maxBodyBytes);
      }

      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidBodyError(error);
  } finally {
    reader?.releaseLock();
  }

  return decodeChunks(chunks, totalBytes);
};

const recipientFromEvent = (event: TrackedResendEmailEvent) =>
  toEmailRecipientList(event.data.to.join(', '));

const parseVerifiedEvent = (
  event: unknown
): BoxedResult<ResendWebhookEvent, AppError> => {
  const parsed = resendWebhookBaseEventSchema.safeParse(event);
  if (!parsed.success) return Result.Error(invalidEventError(parsed.error));
  return Result.Ok(parsed.data);
};

const trackedStatusFromEventType = (eventType: string) =>
  Object.hasOwn(resendEmailStatusByEventType, eventType)
    ? resendEmailStatusByEventType[
        eventType as keyof typeof resendEmailStatusByEventType
      ]
    : undefined;

const parseTrackedEvent = (
  event: ResendWebhookEvent
): BoxedResult<TrackedResendEmailEvent, AppError> => {
  const parsed = trackedResendEmailEventSchema.safeParse(event);
  if (!parsed.success) {
    return Result.Error(invalidTrackedEventError(parsed.error));
  }
  return Result.Ok(parsed.data);
};

export const createResendWebhookHandlers = ({
  getUseCases,
  logger,
  maxBodyBytes,
  verifier,
  trustedProxyDepth,
  rateLimitPerMinute,
  rateLimiter = defaultRateLimiter,
}: ResendWebhookHandlerDeps) => {
  const boundedMaxBodyBytes = normalizeMaxBodyBytes(maxBodyBytes);
  const boundedRateLimitPerMinute =
    Number.isFinite(rateLimitPerMinute) &&
    rateLimitPerMinute !== undefined &&
    rateLimitPerMinute > 0
      ? rateLimitPerMinute
      : DEFAULT_RESEND_WEBHOOK_RATE_LIMIT_PER_MINUTE;

  const enforceRateLimit = (request: Request) => {
    const ip = getClientIp(request, { trustedProxyDepth });
    if (!ip) return undefined;

    const result = rateLimiter.check(
      `webhook:resend:${ip}`,
      boundedRateLimitPerMinute,
      RESEND_WEBHOOK_RATE_LIMIT_WINDOW_MS
    );
    if (result.allowed) return undefined;

    logger?.warn({
      details: {
        provider: EMAIL_PROVIDER_RESEND,
        reason: 'rate_limited',
      },
      event: 'security.webhook_rate_limited',
    });
    return Response.json(
      { ok: false, error: 'too_many_requests' },
      {
        status: 429,
        headers: { 'Retry-After': String(result.retryAfterSeconds) },
      }
    );
  };

  const receive = async (request: Request) => {
    let resendSdkHeaders: VerifyResendWebhookInput['headers'];
    let verifiedEvent: unknown;

    const rateLimited = enforceRateLimit(request);
    if (rateLimited) return rateLimited;

    try {
      resendSdkHeaders = {
        id: requiredHeader(request.headers, 'svix-id'),
        timestamp: requiredHeader(request.headers, 'svix-timestamp'),
        signature: requiredHeader(request.headers, 'svix-signature'),
      };
    } catch (error) {
      logger?.warn({
        details: {
          provider: EMAIL_PROVIDER_RESEND,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        event: 'security.webhook_signature_rejected',
      });
      throw error;
    }

    const payload = await readBoundedTextBody(request, boundedMaxBodyBytes);

    try {
      verifiedEvent = verifier.verify({ payload, headers: resendSdkHeaders });
    } catch (error) {
      logger?.warn({
        details: {
          provider: EMAIL_PROVIDER_RESEND,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        event: 'security.webhook_signature_rejected',
      });
      throw error;
    }

    const event = parseVerifiedEvent(verifiedEvent);
    if (event.isError()) throw event.getError();

    const trackedStatus = trackedStatusFromEventType(event.get().type);
    if (!trackedStatus) {
      return Response.json({ ok: true, ignored: true });
    }

    const trackedEvent = parseTrackedEvent(event.get());
    if (trackedEvent.isError()) throw trackedEvent.getError();

    const externalId = toEmailProviderMessageId(
      trackedEvent.get().data.email_id
    );
    if (externalId.isError()) {
      throw invalidTrackedEventError(externalId.getError());
    }

    const recipient = recipientFromEvent(trackedEvent.get());
    if (recipient.isError()) {
      throw invalidTrackedEventError(recipient.getError());
    }

    const webhookEventId = toEmailWebhookEventId(resendSdkHeaders.id);
    if (webhookEventId.isError()) {
      throw invalidTrackedEventError(webhookEventId.getError());
    }

    const result = await getUseCases().processStatusEvent({
      provider: EMAIL_PROVIDER_RESEND,
      externalId: externalId.get(),
      recipient: recipient.get(),
      subject: trackedEvent.get().data.subject,
      status: trackedStatus,
      webhookEventId: webhookEventId.get(),
      providerEventType: trackedEvent.get().type,
      providerEventCreatedAt: trackedEvent.get().created_at,
      metadata: {
        resendEvent: trackedEvent.get(),
      },
    });

    return match(result)
      .with(Result.P.Error(P.select()), (error) => {
        throw error;
      })
      .with(Result.P.Ok({ type: 'email_status_event_processed' }), () =>
        Response.json({ ok: true, duplicate: false })
      )
      .with(Result.P.Ok({ type: 'email_status_event_duplicate' }), () =>
        Response.json({ ok: true, duplicate: true })
      )
      .exhaustive();
  };

  return { receive };
};

export type ResendWebhookHandlers = ReturnType<
  typeof createResendWebhookHandlers
>;
