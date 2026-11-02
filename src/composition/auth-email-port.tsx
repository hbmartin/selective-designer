import { Result } from '@bloodyowl/boxed';
import { createHash } from 'node:crypto';

import i18n from '@/platform/lib/i18n';
import { sanitizeLogFields } from '@/platform/lib/redaction/sanitize-log-fields';

import type { AuthEmailPort, SendSignInOtpInput } from '@/modules/auth';
import type { EmailGateway } from '@/modules/email';
import { TemplateLoginCode } from '@/modules/email/presentation';
import { isAppError, type Logger } from '@/modules/kernel';
import {
  toEmailIdempotencyKey,
  toEmailRecipientList,
} from '@/modules/kernel/domain/ids';
import { envClient } from '@/platform/env/client';

const signInOtpIdempotencyKey = (input: SendSignInOtpInput) => {
  const digest = createHash('sha256')
    .update(
      `${input.email.trim().toLowerCase()}|${input.otp}|${input.language}`
    )
    .digest('hex');

  return toEmailIdempotencyKey(`auth:sign-in-otp:v1:${digest}`);
};

const shouldLogE2eAuthEmailDiagnostics = () =>
  envClient.VITE_ENV_NAME === 'tests';

const logE2eAuthEmailDiagnostic = ({
  details,
  event,
  logger,
}: {
  details?: Record<string, unknown>;
  event: string;
  logger?: Pick<Logger, 'info'>;
}) => {
  if (!logger) return;
  if (!shouldLogE2eAuthEmailDiagnostics()) return;

  logger.info({
    event,
    direction: 'internal',
    ...(details
      ? {
          details: sanitizeLogFields(details, {
            sensitiveKeys: new Set(['email', 'otp', 'code', 'idempotencyKey']),
          }),
        }
      : {}),
  });
};

const errorDiagnostics = (error: unknown) => {
  if (isAppError(error)) {
    return {
      category: error.category,
      errorCode: error.code,
      message: error.message,
      status: error.status,
    };
  }

  return {
    message: error instanceof Error ? error.message : String(error),
  };
};

export class AuthEmailPortEmailGateway implements AuthEmailPort {
  constructor(
    private readonly emailGateway: EmailGateway,
    private readonly logger?: Pick<Logger, 'info'>
  ) {}

  async sendSignInOtp(
    input: SendSignInOtpInput
  ): ReturnType<AuthEmailPort['sendSignInOtp']> {
    const t = i18n.getFixedT(input.language, 'emails');
    const metadata = {
      source: 'auth.signInOtp',
      language: input.language,
    };

    logE2eAuthEmailDiagnostic({
      event: 'auth.email_port.send_sign_in_otp.start',
      logger: this.logger,
      details: {
        language: input.language,
        metadata,
        recipientCount: 1,
      },
    });

    const recipientList = toEmailRecipientList(input.email);
    if (recipientList.isError()) return Result.Error(recipientList.getError());

    const idempotencyKey = signInOtpIdempotencyKey(input);
    if (idempotencyKey.isError())
      return Result.Error(idempotencyKey.getError());

    const result = await this.emailGateway.sendEmail({
      to: recipientList.get(),
      subject: t('loginCode.subject'),
      template: (
        <TemplateLoginCode language={input.language} code={input.otp} />
      ),
      idempotencyKey: idempotencyKey.get(),
      metadata,
    });
    if (result.isError()) {
      logE2eAuthEmailDiagnostic({
        event: 'auth.email_port.send_sign_in_otp.error',
        logger: this.logger,
        details: {
          ...errorDiagnostics(result.getError()),
          metadata,
        },
      });
      return Result.Error(result.getError());
    }
    logE2eAuthEmailDiagnostic({
      event: 'auth.email_port.send_sign_in_otp.ok',
      logger: this.logger,
      details: {
        metadata,
        outcome: result.get().type,
      },
    });
    return Result.Ok({ type: 'auth_sign_in_otp_sent' });
  }
}
