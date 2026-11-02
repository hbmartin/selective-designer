import { Result } from '@bloodyowl/boxed';
import {
  type AddressInfo,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  EmailStatusRecord,
  EmailStatusRepository,
  EmailTransactionContext,
} from '@/modules/email';
import type { ApplicationResult, TransactionRunner } from '@/modules/kernel';
import {
  toEmailIdempotencyKey,
  toEmailProviderMessageId,
  toEmailRecipientList,
  toEmailStatusId,
} from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';

const testState = vi.hoisted(() => {
  const makeSecret = (label: string) =>
    `${label}-${globalThis.crypto.randomUUID()}`;
  const makeEmailConfig = () => ({
    resendApiKey: makeSecret('resend-api-key'),
    resendWebhookSecret: makeSecret('resend-webhook'),
    resendWebhookMaxBytes: 1_000_000,
    server: 'smtp://127.0.0.1:1025',
    from: 'Start UI <noreply@example.com>',
    deliveryDisabled: false,
  });

  return {
    emailConfig: makeEmailConfig(),
    makeEmailConfig,
    render: vi.fn(),
  };
});

vi.mock('@/modules/kernel/backend', () => ({
  getEmailConfig: () => testState.emailConfig,
}));

vi.mock('@react-email/render', () => ({
  render: testState.render,
}));

type SmtpSession = {
  commands: string[];
  data: string;
};

const recipient = unwrapParseResult(toEmailRecipientList('user@example.com'));
const idempotencyKey = unwrapParseResult(toEmailIdempotencyKey('key-1'));
const sentExternalId = unwrapParseResult(
  toEmailProviderMessageId('smtp_existing')
);

const makeEmailStatusRecord = (
  overrides: Partial<EmailStatusRecord> = {}
): EmailStatusRecord => ({
  id: unwrapParseResult(toEmailStatusId('status-1')),
  provider: 'smtp',
  externalId: null,
  recipient,
  subject: 'Login code',
  status: 'send_attempted',
  idempotencyKey,
  lastWebhookEventId: null,
  metadata: {},
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const makeStatusRepository = (): EmailStatusRepository =>
  ({
    recordSendAttempt: vi.fn(async () =>
      Result.Ok({
        type: 'email_status_recorded' as const,
        record: makeEmailStatusRecord(),
      })
    ),
    upsertStatusByExternalId: vi.fn(async () =>
      Result.Ok({
        type: 'email_status_recorded' as const,
        record: makeEmailStatusRecord({
          externalId: sentExternalId,
          status: 'sent',
        }),
      })
    ),
    getByExternalId: vi.fn(),
    listRecent: vi.fn(),
    countByStatus: vi.fn(),
  }) satisfies EmailStatusRepository;

const makeStatusTransactionRunner = (
  emailStatusRepository: EmailStatusRepository
): TransactionRunner<EmailTransactionContext> => ({
  run: (work) => work({ emailStatusRepository }),
});

function getOk<TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) {
  if (result.isError()) throw result.getError();
  return result.get();
}

function getError<TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) {
  if (result.isOk()) {
    throw new Error(`Expected Result.Error, got ${result.get().type}`);
  }
  return result.getError();
}

const handleSmtpLine = (
  socket: Socket,
  session: SmtpSession,
  line: string,
  state: { inData: boolean; dataLines: string[] }
) => {
  if (state.inData) {
    if (line === '.') {
      session.data = state.dataLines.join('\n');
      state.inData = false;
      socket.write('250 queued\r\n');
      return;
    }

    state.dataLines.push(line);
    return;
  }

  session.commands.push(line);
  if (line.startsWith('EHLO')) {
    socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
  } else if (line.startsWith('AUTH PLAIN')) {
    socket.write('235 authenticated\r\n');
  } else if (line === 'DATA') {
    state.inData = true;
    socket.write('354 end with dot\r\n');
  } else if (line === 'QUIT') {
    socket.write('221 bye\r\n');
    socket.end();
  } else {
    socket.write('250 ok\r\n');
  }
};

const startSmtpServer = async (): Promise<{
  close: () => Promise<void>;
  sessions: SmtpSession[];
  url: string;
}> => {
  const sessions: SmtpSession[] = [];
  const server: Server = createServer((socket) => {
    const session: SmtpSession = { commands: [], data: '' };
    const state = { inData: false, dataLines: [] as string[] };
    let buffer = '';
    sessions.push(session);
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let lineEnd = buffer.indexOf('\n');
      while (lineEnd >= 0) {
        const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
        buffer = buffer.slice(lineEnd + 1);
        handleSmtpLine(socket, session, line, state);
        lineEnd = buffer.indexOf('\n');
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP SMTP server address');
  }
  const tcpAddress: AddressInfo = address;

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
    sessions,
    url: `smtp://${tcpAddress.address}:${tcpAddress.port}`,
  };
};

const startFailingSmtpServer = async (): Promise<{
  close: () => Promise<void>;
  sessions: SmtpSession[];
  url: string;
}> => {
  const server: Server = createServer((socket) => {
    socket.on('error', () => {});
    socket.destroy(new Error('socket reset by test SMTP server'));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP SMTP server address');
  }
  const tcpAddress: AddressInfo = address;

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
    sessions: [],
    url: `smtp://${tcpAddress.address}:${tcpAddress.port}`,
  };
};

const loadGateway = async () =>
  import('@/modules/email/infrastructure/smtp/email-gateway-smtp');

describe('EmailGatewaySmtp', () => {
  let smtpServer: Awaited<ReturnType<typeof startSmtpServer>> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(testState.emailConfig, testState.makeEmailConfig());
    testState.render.mockImplementation(async (_template, options) =>
      options?.plainText
        ? 'Plain text login code 123456'
        : '<p>HTML login code 123456</p>'
    );
  });

  afterEach(async () => {
    await smtpServer?.close();
    smtpServer = undefined;
  });

  it('renders and delivers email through SMTP before recording sent status', async () => {
    smtpServer = await startSmtpServer();
    testState.emailConfig.server = smtpServer.url;
    const statusRepository = makeStatusRepository();
    const { EmailGatewaySmtp } = await loadGateway();

    const result = await new EmailGatewaySmtp({
      statusTransactionRunner: makeStatusTransactionRunner(statusRepository),
    }).sendEmail({
      to: recipient,
      subject: 'Login code',
      template: createElement('div', null, '123456'),
      idempotencyKey,
      metadata: { source: 'test' },
    });

    expect(getOk(result)).toMatchObject({
      type: 'email_send_recorded',
      provider: 'smtp',
      externalId: expect.stringMatching(/^smtp_/),
    });
    expect(smtpServer.sessions).toHaveLength(1);
    expect(smtpServer.sessions[0]?.commands).toEqual(
      expect.arrayContaining([
        'EHLO start-ui.local',
        'MAIL FROM:<noreply@example.com>',
        'RCPT TO:<user@example.com>',
        'DATA',
        'QUIT',
      ])
    );
    expect(smtpServer.sessions[0]?.data).toContain('Subject: Login code');
    expect(smtpServer.sessions[0]?.data).toContain(
      'Plain text login code 123456'
    );
    expect(smtpServer.sessions[0]?.data).toContain(
      '<p>HTML login code 123456</p>'
    );
    expect(statusRepository.recordSendAttempt).toHaveBeenCalledWith({
      provider: 'smtp',
      recipient: 'user@example.com',
      subject: 'Login code',
      idempotencyKey: 'key-1',
      metadata: { source: 'test' },
    });
    expect(statusRepository.upsertStatusByExternalId).toHaveBeenCalledWith({
      provider: 'smtp',
      externalId: expect.stringMatching(/^smtp_/),
      recipient: 'user@example.com',
      subject: 'Login code',
      status: 'sent',
      idempotencyKey: 'key-1',
      metadata: { source: 'test' },
    });
  });

  it('skips SMTP delivery when delivery is disabled', async () => {
    testState.emailConfig.deliveryDisabled = true;
    const statusRepository = makeStatusRepository();
    const { EmailGatewaySmtp } = await loadGateway();

    const result = await new EmailGatewaySmtp({
      statusTransactionRunner: makeStatusTransactionRunner(statusRepository),
    }).sendEmail({
      to: recipient,
      subject: 'Login code',
      template: createElement('div', null, '123456'),
      idempotencyKey,
    });

    expect(getOk(result)).toEqual({
      type: 'email_send_skipped',
      provider: 'smtp',
    });
    expect(statusRepository.recordSendAttempt).not.toHaveBeenCalled();
    expect(statusRepository.upsertStatusByExternalId).not.toHaveBeenCalled();
  });

  it('records a failed send when the SMTP socket fails after connect', async () => {
    smtpServer = await startFailingSmtpServer();
    testState.emailConfig.server = smtpServer.url;
    const statusRepository = makeStatusRepository();
    const { EmailGatewaySmtp } = await loadGateway();

    const result = await new EmailGatewaySmtp({
      statusTransactionRunner: makeStatusTransactionRunner(statusRepository),
    }).sendEmail({
      to: recipient,
      subject: 'Login code',
      template: createElement('div', null, '123456'),
      idempotencyKey,
    });

    expect(getError(result)).toMatchObject({ code: 'EMAIL_SEND_FAILED' });
    expect(statusRepository.recordSendAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: 'smtp',
        status: 'send_failed',
        metadata: {
          providerError: expect.objectContaining({
            provider: 'smtp',
            message: expect.any(String),
          }),
        },
      })
    );
  });
});
