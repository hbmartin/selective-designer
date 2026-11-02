import { Result } from '@bloodyowl/boxed';
import { render } from '@react-email/render';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import type { ReactElement } from 'react';

import { sanitizeLogFields } from '@/platform/lib/redaction/sanitize-log-fields';

import {
  EMAIL_PROVIDER_SMTP,
  type EmailGateway,
  type EmailMetadata,
  type EmailTransactionContext,
  type RecordEmailSendAttemptInput,
  type SendEmailParams,
} from '@/modules/email';
import {
  AppError,
  type EmailProviderMessageId,
  type EmailRecipientList,
  type Logger,
  toEmailProviderMessageId,
  toEmailRecipientList,
  type TransactionRunner,
} from '@/modules/kernel';
import { getEmailConfig } from '@/modules/kernel/backend';
import { envClient } from '@/platform/env/client';

type EmailGatewaySmtpDeps = {
  logger?: Pick<Logger, 'info'>;
  statusTransactionRunner: TransactionRunner<EmailTransactionContext>;
};

type SendEmailResult = Awaited<ReturnType<EmailGateway['sendEmail']>>;

type SmtpServerConfig = {
  host: string;
  port: number;
  username?: string;
  password?: string;
};

type SmtpMessage = {
  from: string;
  recipients: string[];
  raw: string;
};

const smtpTimeoutMs = 15_000;
const SMTP_DIAGNOSTIC_SENSITIVE_KEYS = new Set([
  'bcc',
  'cc',
  'code',
  'email',
  'from',
  'idempotencyKey',
  'otp',
  'recipient',
  'recipients',
  'replyTo',
  'to',
]);

const recipientToStatusValue = (recipient: SendEmailParams['to']) =>
  Array.isArray(recipient)
    ? toEmailRecipientList(recipient.join(', '))
    : Result.Ok(recipient);

const splitRecipients = (
  recipient: SendEmailParams['to'] | undefined
): string[] => {
  if (!recipient) return [];
  const values = Array.isArray(recipient) ? recipient : [recipient];

  return values.flatMap((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
};

const extractAddress = (value: string) => {
  const trimmed = value.trim();
  const start = trimmed.lastIndexOf('<');
  if (start < 0) return trimmed;

  const end = trimmed.indexOf('>', start + 1);
  if (end <= start) return trimmed;

  return trimmed.slice(start + 1, end).trim();
};

const sanitizeHeaderValue = (value: string) =>
  value.replace(/[\r\n]+/g, ' ').trim();

const encodeHeaderValue = (value: string) => {
  const sanitized = sanitizeHeaderValue(value);
  if (/^[\x20-\x7e]*$/.test(sanitized)) return sanitized;
  return `=?UTF-8?B?${Buffer.from(sanitized, 'utf8').toString('base64')}?=`;
};

const dotStuff = (value: string) =>
  value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');

const smtpExternalId = (idempotencyKey: string) =>
  toEmailProviderMessageId(
    `smtp_${createHash('sha256').update(idempotencyKey).digest('hex')}`
  );

const providerErrorMetadata = (error: unknown): EmailMetadata => {
  const metadata: EmailMetadata = {
    providerError: {
      provider: EMAIL_PROVIDER_SMTP,
      message: error instanceof Error ? error.message : String(error),
    },
  };

  return metadata;
};

const idempotencyKeyError = () =>
  new AppError({
    code: 'EMAIL_IDEMPOTENCY_KEY_REQUIRED',
    category: 'system',
    status: 500,
    message: 'Email sends require a non-empty idempotency key',
  });

const missingEmailServerError = () =>
  new AppError({
    code: 'EMAIL_SMTP_SERVER_NOT_CONFIGURED',
    category: 'system',
    status: 500,
    message: 'EMAIL_SERVER must be configured for SMTP email delivery',
  });

const unsupportedEmailServerError = (server: string) =>
  new AppError({
    code: 'EMAIL_SMTP_SERVER_UNSUPPORTED',
    category: 'system',
    status: 500,
    message: 'EMAIL_SERVER must use the smtp:// protocol',
    details: { server },
  });

const smtpProtocolError = (
  message: string,
  details?: Record<string, unknown>
) =>
  new AppError({
    code: 'EMAIL_SMTP_PROTOCOL_ERROR',
    category: 'system',
    status: 500,
    message,
    ...(details ? { details } : {}),
  });

const smtpTimeoutError = () =>
  new AppError({
    code: 'EMAIL_SMTP_TIMEOUT',
    category: 'system',
    status: 504,
    message: 'SMTP connection timed out',
  });

// Distinct from smtpProtocolError so the send loop can tell "the stream ended
// out from under us" (a symptom) apart from a genuine protocol failure like a
// 535/550 (the real cause). Only the former should defer to a captured socket
// error (timeout / reset); the latter must win.
const smtpConnectionClosedError = (command: string) =>
  new AppError({
    code: 'EMAIL_SMTP_CONNECTION_CLOSED',
    category: 'system',
    status: 502,
    message: 'SMTP connection closed while waiting',
    details: { command },
  });

const shouldLogE2eSmtpDiagnostics = () => envClient.VITE_ENV_NAME === 'tests';

const logE2eSmtpDiagnostic = (
  logger: Pick<Logger, 'info'> | undefined,
  event: string,
  details?: Record<string, unknown>
) => {
  if (!logger) return;
  if (!shouldLogE2eSmtpDiagnostics()) return;

  logger.info({
    event,
    direction: 'internal',
    ...(details
      ? {
          details: sanitizeLogFields(details, {
            sensitiveKeys: SMTP_DIAGNOSTIC_SENSITIVE_KEYS,
          }),
        }
      : {}),
  });
};

const smtpErrorDiagnostics = (error: unknown) => {
  if (error instanceof AppError) {
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

const parseSmtpServer = (server: string): SmtpServerConfig => {
  const url = new URL(server);
  if (url.protocol !== 'smtp:') {
    throw unsupportedEmailServerError(server);
  }

  const port = url.port ? Number.parseInt(url.port, 10) : 25;
  return {
    host: url.hostname === '0.0.0.0' ? '127.0.0.1' : url.hostname,
    port,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
};

const buildSmtpMessage = (input: {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  html: string;
  text: string;
  messageId: string;
  headers?: Record<string, string>;
}): SmtpMessage => {
  const boundary = `start-ui-${createHash('sha256')
    .update(input.messageId)
    .digest('hex')}`;
  const recipients = [...input.to, ...input.cc, ...input.bcc];
  const headers = [
    `From: ${sanitizeHeaderValue(input.from)}`,
    `To: ${input.to.map(sanitizeHeaderValue).join(', ')}`,
    ...(input.cc.length
      ? [`Cc: ${input.cc.map(sanitizeHeaderValue).join(', ')}`]
      : []),
    ...(input.replyTo.length
      ? [`Reply-To: ${input.replyTo.map(sanitizeHeaderValue).join(', ')}`]
      : []),
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Message-ID: <${sanitizeHeaderValue(input.messageId)}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ...(input.headers
      ? Object.entries(input.headers).map(
          ([key, value]) =>
            `${sanitizeHeaderValue(key)}: ${sanitizeHeaderValue(value)}`
        )
      : []),
  ];
  const raw = [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.text,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    input.html,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return {
    from: extractAddress(input.from),
    recipients: recipients.map(extractAddress),
    raw,
  };
};

const parseSmtpCode = (line: string) => {
  const code = Number.parseInt(line.slice(0, 3), 10);
  if (Number.isNaN(code)) {
    throw smtpProtocolError('Malformed SMTP response', { response: line });
  }
  return code;
};

const readSmtpResponse = async (
  lines: AsyncIterator<string>,
  command: string
) => {
  const responseLines: string[] = [];

  while (true) {
    const result = await lines.next();
    if (result.done) {
      throw smtpConnectionClosedError(command);
    }

    responseLines.push(result.value);
    if (/^\d{3} /.test(result.value)) {
      return {
        code: parseSmtpCode(result.value),
        text: responseLines.join('\n'),
      };
    }
  }
};

const expectSmtpResponse = async (
  lines: AsyncIterator<string>,
  command: string,
  expectedCodes: number[]
) => {
  const response = await readSmtpResponse(lines, command);
  if (!expectedCodes.includes(response.code)) {
    throw smtpProtocolError('SMTP command failed', {
      code: response.code,
      command,
      response: response.text,
    });
  }
  return response;
};

const writeSmtpLine = (socket: Socket, line: string) => {
  socket.write(`${line}\r\n`);
};

const sendSmtpMessage = async (
  config: SmtpServerConfig,
  message: SmtpMessage
) => {
  const socket = connect({ host: config.host, port: config.port });
  let socketError: Error | undefined;
  socket.on('error', (error) => {
    socketError = error;
  });
  socket.setTimeout(smtpTimeoutMs);
  socket.on('timeout', () => {
    socket.destroy(smtpTimeoutError());
  });
  const lineReader = createInterface({ input: socket, crlfDelay: Infinity });
  const lines = lineReader[Symbol.asyncIterator]();

  try {
    await once(socket, 'connect');
    await expectSmtpResponse(lines, 'greeting', [220]);

    writeSmtpLine(socket, 'EHLO start-ui.local');
    await expectSmtpResponse(lines, 'EHLO', [250]);

    if (config.username || config.password) {
      const auth = Buffer.from(
        `\0${config.username ?? ''}\0${config.password ?? ''}`,
        'utf8'
      ).toString('base64');
      writeSmtpLine(socket, `AUTH PLAIN ${auth}`);
      await expectSmtpResponse(lines, 'AUTH PLAIN', [235]);
    }

    writeSmtpLine(socket, `MAIL FROM:<${message.from}>`);
    await expectSmtpResponse(lines, 'MAIL FROM', [250]);

    for (const recipient of message.recipients) {
      writeSmtpLine(socket, `RCPT TO:<${recipient}>`);
      await expectSmtpResponse(lines, 'RCPT TO', [250, 251]);
    }

    writeSmtpLine(socket, 'DATA');
    await expectSmtpResponse(lines, 'DATA', [354]);
    socket.write(`${dotStuff(message.raw)}\r\n.\r\n`);
    await expectSmtpResponse(lines, 'message body', [250]);

    writeSmtpLine(socket, 'QUIT');
    await expectSmtpResponse(lines, 'QUIT', [221]);
  } catch (error) {
    // A premature close surfaces only as EMAIL_SMTP_CONNECTION_CLOSED; in that
    // case prefer the underlying socket cause (timeout / reset), which explains
    // *why*. A genuine protocol error (e.g. 535/550) is the real cause and must
    // win over any trailing socket reset, so it is thrown as-is.
    if (
      socketError &&
      error instanceof AppError &&
      error.code === 'EMAIL_SMTP_CONNECTION_CLOSED'
    ) {
      throw socketError;
    }
    throw error;
  } finally {
    lineReader.close();
    socket.end();
  }
};

export class EmailGatewaySmtp implements EmailGateway {
  private readonly logger?: Pick<Logger, 'info'>;
  private readonly statusTransactionRunner: TransactionRunner<EmailTransactionContext>;

  constructor(deps: EmailGatewaySmtpDeps) {
    this.logger = deps.logger;
    this.statusTransactionRunner = deps.statusTransactionRunner;
  }

  private recordSendAttempt(input: RecordEmailSendAttemptInput) {
    return this.statusTransactionRunner.run(({ emailStatusRepository }) =>
      emailStatusRepository.recordSendAttempt(input)
    );
  }

  private upsertStatusByExternalId(
    input: SendEmailParams,
    externalId: EmailProviderMessageId,
    recipient: EmailRecipientList
  ) {
    return this.statusTransactionRunner.run(({ emailStatusRepository }) =>
      emailStatusRepository.upsertStatusByExternalId({
        provider: EMAIL_PROVIDER_SMTP,
        externalId,
        recipient,
        subject: input.subject,
        status: 'sent',
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
      })
    );
  }

  async sendEmail(
    input: SendEmailParams
  ): ReturnType<EmailGateway['sendEmail']> {
    if (!input.idempotencyKey.trim()) {
      logE2eSmtpDiagnostic(
        this.logger,
        'email.smtp.send.invalid_idempotency_key',
        {
          provider: EMAIL_PROVIDER_SMTP,
        }
      );
      return Result.Error(idempotencyKeyError());
    }

    const emailConfig = getEmailConfig();
    if (emailConfig.deliveryDisabled) {
      logE2eSmtpDiagnostic(
        this.logger,
        'email.smtp.send.skipped_delivery_disabled',
        {
          provider: EMAIL_PROVIDER_SMTP,
        }
      );
      return Result.Ok({
        type: 'email_send_skipped',
        provider: EMAIL_PROVIDER_SMTP,
      });
    }
    const emailServer = emailConfig.server;
    if (!emailServer) {
      logE2eSmtpDiagnostic(this.logger, 'email.smtp.send.missing_server', {
        provider: EMAIL_PROVIDER_SMTP,
      });
      return Result.Error(missingEmailServerError());
    }

    const recipient = recipientToStatusValue(input.to);
    if (recipient.isError()) return Result.Error(recipient.getError());
    const recipientValue = recipient.get();

    logE2eSmtpDiagnostic(this.logger, 'email.smtp.send.record_attempt.start', {
      metadata: input.metadata,
      provider: EMAIL_PROVIDER_SMTP,
      recipientCount: splitRecipients(input.to).length,
      subjectLength: input.subject.length,
    });
    const attemptResult = await this.recordSendAttempt({
      provider: EMAIL_PROVIDER_SMTP,
      recipient: recipientValue,
      subject: input.subject,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
    });
    if (attemptResult.isError()) {
      logE2eSmtpDiagnostic(
        this.logger,
        'email.smtp.send.record_attempt.error',
        {
          ...smtpErrorDiagnostics(attemptResult.getError()),
          provider: EMAIL_PROVIDER_SMTP,
        }
      );
      return Result.Error(attemptResult.getError());
    }

    const attempt = attemptResult.get().record;
    if (attempt.externalId) {
      logE2eSmtpDiagnostic(this.logger, 'email.smtp.send.idempotent_replay', {
        externalId: attempt.externalId,
        provider: EMAIL_PROVIDER_SMTP,
        status: attempt.status,
      });
      return Result.Ok({
        type: 'email_send_recorded',
        provider: EMAIL_PROVIDER_SMTP,
        externalId: attempt.externalId,
      });
    }

    const recordFailedAttempt = async (
      metadata?: EmailMetadata
    ): Promise<SendEmailResult | null> => {
      const failedAttemptResult = await this.recordSendAttempt({
        provider: EMAIL_PROVIDER_SMTP,
        recipient: recipientValue,
        subject: input.subject,
        idempotencyKey: input.idempotencyKey,
        status: 'send_failed',
        metadata: {
          ...input.metadata,
          ...metadata,
        },
      });
      if (failedAttemptResult.isError()) {
        logE2eSmtpDiagnostic(
          this.logger,
          'email.smtp.send.record_failed_attempt.error',
          {
            ...smtpErrorDiagnostics(failedAttemptResult.getError()),
            provider: EMAIL_PROVIDER_SMTP,
          }
        );
        return Result.Error(failedAttemptResult.getError());
      }

      const failedAttempt = failedAttemptResult.get().record;
      if (failedAttempt.externalId) {
        logE2eSmtpDiagnostic(
          this.logger,
          'email.smtp.send.record_failed_attempt.replayed',
          {
            externalId: failedAttempt.externalId,
            provider: EMAIL_PROVIDER_SMTP,
            status: failedAttempt.status,
          }
        );
        return Result.Ok({
          type: 'email_send_recorded',
          provider: EMAIL_PROVIDER_SMTP,
          externalId: failedAttempt.externalId,
        });
      }

      return null;
    };

    const renderFailed = async (error: unknown): Promise<SendEmailResult> => {
      const failedAttempt = await recordFailedAttempt(
        providerErrorMetadata(error)
      );
      if (failedAttempt) return failedAttempt;

      return Result.Error(
        new AppError({
          code: 'EMAIL_RENDER_FAILED',
          category: 'system',
          status: 500,
          message: 'Failed to render email',
          cause: error,
        })
      );
    };

    const htmlResult = await Result.fromPromise(
      render(input.template as ReactElement)
    );
    if (htmlResult.isError()) {
      logE2eSmtpDiagnostic(this.logger, 'email.smtp.send.render_html.error', {
        ...smtpErrorDiagnostics(htmlResult.getError()),
        provider: EMAIL_PROVIDER_SMTP,
      });
      return renderFailed(htmlResult.getError());
    }

    const textResult = await Result.fromPromise(
      render(input.template as ReactElement, {
        plainText: true,
      })
    );
    if (textResult.isError()) {
      logE2eSmtpDiagnostic(this.logger, 'email.smtp.send.render_text.error', {
        ...smtpErrorDiagnostics(textResult.getError()),
        provider: EMAIL_PROVIDER_SMTP,
      });
      return renderFailed(textResult.getError());
    }

    const html = htmlResult.get();
    const text = textResult.get();
    const externalId = smtpExternalId(input.idempotencyKey);
    if (externalId.isError()) return Result.Error(externalId.getError());
    const externalIdValue = externalId.get();

    const serverResult = await Result.fromPromise(
      Promise.resolve().then(() => {
        const smtpServer = parseSmtpServer(emailServer);
        logE2eSmtpDiagnostic(
          this.logger,
          'email.smtp.send.smtp_delivery.start',
          {
            externalId: externalIdValue,
            provider: EMAIL_PROVIDER_SMTP,
            recipientCount: splitRecipients(input.to).length,
            serverHost: smtpServer.host,
            serverPort: smtpServer.port,
          }
        );

        return sendSmtpMessage(
          smtpServer,
          buildSmtpMessage({
            from: emailConfig.from,
            to: splitRecipients(input.to),
            cc: splitRecipients(input.cc),
            bcc: splitRecipients(input.bcc),
            replyTo: splitRecipients(input.replyTo),
            subject: input.subject,
            html,
            text,
            messageId: `${externalIdValue}@start-ui.local`,
            headers: input.headers,
          })
        );
      })
    );
    if (serverResult.isError()) {
      logE2eSmtpDiagnostic(this.logger, 'email.smtp.send.smtp_delivery.error', {
        ...smtpErrorDiagnostics(serverResult.getError()),
        externalId: externalIdValue,
        provider: EMAIL_PROVIDER_SMTP,
      });
      const failedAttempt = await recordFailedAttempt(
        providerErrorMetadata(serverResult.getError())
      );
      if (failedAttempt) return failedAttempt;

      return Result.Error(
        new AppError({
          code: 'EMAIL_SEND_FAILED',
          category: 'system',
          status: 500,
          message: 'Failed to send email',
          cause: serverResult.getError(),
        })
      );
    }

    logE2eSmtpDiagnostic(this.logger, 'email.smtp.send.smtp_delivery.ok', {
      externalId: externalIdValue,
      provider: EMAIL_PROVIDER_SMTP,
    });
    const upsertResult = await this.upsertStatusByExternalId(
      input,
      externalIdValue,
      recipientValue
    );
    if (upsertResult.isError()) {
      logE2eSmtpDiagnostic(this.logger, 'email.smtp.send.status_upsert.error', {
        ...smtpErrorDiagnostics(upsertResult.getError()),
        externalId: externalIdValue,
        provider: EMAIL_PROVIDER_SMTP,
      });
      return Result.Error(upsertResult.getError());
    }

    logE2eSmtpDiagnostic(this.logger, 'email.smtp.send.status_upsert.ok', {
      externalId: externalIdValue,
      provider: EMAIL_PROVIDER_SMTP,
    });
    return Result.Ok({
      type: 'email_send_recorded',
      provider: EMAIL_PROVIDER_SMTP,
      externalId: externalIdValue,
    });
  }
}
