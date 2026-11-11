import { Result } from '@bloodyowl/boxed';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailOverrides } from '@/composition/email';
import type { EmailStatusRepository } from '@/modules/email';
import {
  AppError,
  toEmailIdempotencyKey,
  toEmailRecipientList,
} from '@/modules/kernel';
import { unwrapParseResult } from '@/modules/kernel/testing';

const testState = vi.hoisted(() => {
  const makeEmailConfig = () => ({
    resendApiKey: 'resend-api-key', // pragma: allowlist secret
    resendWebhookSecret: 'resend-webhook-secret', // pragma: allowlist secret
    resendWebhookMaxBytes: 1_000_000,
    server: undefined as string | undefined,
    from: 'Selective Designer <noreply@example.com>',
    deliveryDisabled: true,
  });

  return {
    emailConfig: makeEmailConfig(),
    makeEmailConfig,
    failure: undefined as Error | undefined,
  };
});

vi.mock('@/modules/kernel/backend', () => ({
  createTelemetryLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
  getEmailConfig: () => {
    if (testState.failure) throw testState.failure;
    return testState.emailConfig;
  },
}));

const makeStatusRepository = (): EmailStatusRepository =>
  ({
    recordSendAttempt: vi.fn(async () =>
      Result.Ok({
        type: 'email_status_recorded' as const,
        record: null,
      })
    ),
    upsertStatusByExternalId: vi.fn(),
    getByExternalId: vi.fn(),
    listRecent: vi.fn(),
    countByStatus: vi.fn(),
  }) as unknown as EmailStatusRepository;

const makeOverrides = (): EmailOverrides => ({
  db: {} as NonNullable<EmailOverrides['db']>,
  emailStatusRepository: makeStatusRepository(),
});

describe('email composition', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    testState.failure = undefined;
    Object.assign(testState.emailConfig, testState.makeEmailConfig());
    const { __resetEmailComposition } = await import('@/composition/email');
    __resetEmailComposition();
  });

  it('selects the SMTP gateway when EMAIL_SERVER is configured', async () => {
    testState.emailConfig.server = 'smtp://127.0.0.1:1025';
    const { getEmailGateway } = await import('@/composition/email');

    const result = await getEmailGateway(makeOverrides()).sendEmail({
      to: unwrapParseResult(toEmailRecipientList('user@example.com')),
      subject: 'Login code',
      template: createElement('div', null, '123456'),
      idempotencyKey: unwrapParseResult(toEmailIdempotencyKey('key-1')),
    });

    expect(result).toMatchObject({
      tag: 'Ok',
      value: {
        type: 'email_send_skipped',
        provider: 'smtp',
      },
    });
  });

  it('selects the Resend gateway when EMAIL_SERVER is not configured', async () => {
    const { getEmailGateway } = await import('@/composition/email');

    const result = await getEmailGateway(makeOverrides()).sendEmail({
      to: unwrapParseResult(toEmailRecipientList('user@example.com')),
      subject: 'Login code',
      template: createElement('div', null, '123456'),
      idempotencyKey: unwrapParseResult(toEmailIdempotencyKey('key-1')),
    });

    expect(result).toMatchObject({
      tag: 'Ok',
      value: {
        type: 'email_send_skipped',
        provider: 'resend',
      },
    });
  });

  it('returns a typed configuration error before attempting delivery', async () => {
    testState.failure = new AppError({
      code: 'CONFIGURATION_ERROR',
      category: 'system',
      status: 500,
      message: 'Email transport is incomplete',
    });
    const { getEmailGateway } = await import('@/composition/email');
    const overrides = makeOverrides();
    const result = await getEmailGateway(overrides).sendEmail({
      to: unwrapParseResult(toEmailRecipientList('user@example.com')),
      subject: 'Test delivery',
      template: createElement('div'),
      idempotencyKey: unwrapParseResult(toEmailIdempotencyKey('key-1')),
    });
    expect(result.isError() && result.getError()).toBe(testState.failure);
    expect(
      overrides.emailStatusRepository?.recordSendAttempt
    ).not.toHaveBeenCalled();
  });
});
