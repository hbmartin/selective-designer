import { Result } from '@bloodyowl/boxed';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { EmailGateway } from '@/modules/email';
import { AppError } from '@/modules/kernel';
import {
  toEmailAddress,
  toEmailIdempotencyKey,
  toEmailProviderMessageId,
  toEmailRecipientList,
  toLanguageCode,
  toOtpCode,
  unwrapParseResult,
} from '@/modules/kernel/testing';

vi.mock('@/platform/lib/i18n', () => ({
  default: {
    getFixedT: () => (key: string) => `translated:${key}`,
  },
}));

describe('AuthEmailPortEmailGateway', () => {
  it('sends OTP emails through EmailGateway with deterministic hashed idempotency keys', async () => {
    const sendEmail = vi.fn(async () =>
      Result.Ok({
        type: 'email_send_recorded' as const,
        provider: 'resend' as const,
        externalId: unwrapParseResult(toEmailProviderMessageId('email_123')),
      })
    );
    const gateway = { sendEmail } satisfies EmailGateway;
    const { AuthEmailPortEmailGateway } =
      await import('@/composition/auth-email-port');

    const result = await new AuthEmailPortEmailGateway(gateway).sendSignInOtp({
      email: unwrapParseResult(toEmailAddress(' User@Example.com ')),
      otp: unwrapParseResult(toOtpCode('123456')),
      language: unwrapParseResult(toLanguageCode('en')),
    });

    const expectedDigest = createHash('sha256')
      .update('user@example.com|123456|en')
      .digest('hex');
    const idempotencyKey = unwrapParseResult(
      toEmailIdempotencyKey(`auth:sign-in-otp:v1:${expectedDigest}`)
    );

    expect(sendEmail).toHaveBeenCalledWith({
      to: unwrapParseResult(toEmailRecipientList('User@Example.com')),
      subject: 'translated:loginCode.subject',
      template: expect.any(Object),
      idempotencyKey,
      metadata: {
        source: 'auth.signInOtp',
        language: 'en',
      },
    });
    expect(idempotencyKey).not.toContain('User@Example.com');
    expect(idempotencyKey).not.toContain('123456');
    expect(
      result.match({ Ok: (outcome) => outcome, Error: () => null })
    ).toEqual({
      type: 'auth_sign_in_otp_sent',
    });
  });

  it('forwards EmailGateway errors unchanged', async () => {
    const error = new AppError({
      code: 'EMAIL_SEND_FAILED',
      category: 'system',
      status: 500,
      message: 'Failed to send email',
    });
    const sendEmail = vi.fn(async () => Result.Error(error));
    const gateway = { sendEmail } satisfies EmailGateway;
    const { AuthEmailPortEmailGateway } =
      await import('@/composition/auth-email-port');

    const result = await new AuthEmailPortEmailGateway(gateway).sendSignInOtp({
      email: unwrapParseResult(toEmailAddress('user@example.com')),
      otp: unwrapParseResult(toOtpCode('123456')),
      language: unwrapParseResult(toLanguageCode('en')),
    });

    expect(result.match({ Ok: () => null, Error: (value) => value })).toBe(
      error
    );
  });
});
