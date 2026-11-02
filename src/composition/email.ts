import {
  createEmailUseCases,
  type EmailGateway,
  type EmailStatusRepository,
  type EmailTransactionContext,
  type EmailUseCases,
} from '@/modules/email';
import {
  createEmailStatusRepository,
  createEmailStatusTransactionRunner,
  EmailGatewayResend,
  EmailGatewaySmtp,
  ResendWebhookVerifier,
} from '@/modules/email/backend';
import type { Logger, TransactionRunner } from '@/modules/kernel';
import {
  createTelemetryLogger,
  getEmailConfig,
} from '@/modules/kernel/backend';
import {
  createTransactionRunner,
  type Database,
  type DbTransaction,
  getDefaultDbClient,
} from '@/modules/kernel/infrastructure/db/client';

import { createCachedFactory } from './shared/singleton';
import { telemetryProxy } from './telemetry';

type EmailKernel = {
  db: Database;
  transactionRunner: TransactionRunner<DbTransaction>;
};

export type EmailOverrides = {
  kernel?: EmailKernel;
  db?: Database;
  emailGateway?: EmailGateway;
  emailStatusRepository?: EmailStatusRepository;
  resendWebhookVerifier?: ResendWebhookVerifier;
};

type EmailServices = {
  gateway: EmailGateway;
  useCases: EmailUseCases;
  resendWebhookVerifier: ResendWebhookVerifier;
};

const createEmailKernel = (db: Database): EmailKernel => ({
  db,
  transactionRunner: createTransactionRunner(db),
});

const getDefaultEmailKernel = (): EmailKernel =>
  createEmailKernel(getDefaultDbClient());

const createConfiguredEmailGateway = (
  statusTransactionRunner: TransactionRunner<EmailTransactionContext>,
  logger?: Pick<Logger, 'info'>
): EmailGateway => ({
  sendEmail(input) {
    if (getEmailConfig().server) {
      return new EmailGatewaySmtp({
        logger,
        statusTransactionRunner,
      }).sendEmail(input);
    }

    return new EmailGatewayResend({ statusTransactionRunner }).sendEmail(input);
  },
});

const buildEmailServices = (overrides?: EmailOverrides): EmailServices => {
  const kernel =
    overrides?.kernel ??
    (overrides?.db ? createEmailKernel(overrides.db) : getDefaultEmailKernel());
  const emailStatusRepositoryOverride = overrides?.emailStatusRepository;
  const emailStatusRepository =
    emailStatusRepositoryOverride ??
    createEmailStatusRepository({ db: kernel.db });
  const statusTransactionRunner: TransactionRunner<EmailTransactionContext> =
    emailStatusRepositoryOverride
      ? {
          run: (work) =>
            work({ emailStatusRepository: emailStatusRepositoryOverride }),
        }
      : createEmailStatusTransactionRunner(kernel.transactionRunner);

  const gateway =
    overrides?.emailGateway ??
    createConfiguredEmailGateway(
      statusTransactionRunner,
      createTelemetryLogger({ telemetry: telemetryProxy })
    );

  return {
    gateway,
    useCases: createEmailUseCases({
      emailStatusRepository,
      transactionRunner: statusTransactionRunner,
    }),
    resendWebhookVerifier:
      overrides?.resendWebhookVerifier ?? new ResendWebhookVerifier(),
  };
};

const factory = createCachedFactory<EmailServices, EmailOverrides>(
  buildEmailServices
);

export const getEmailServices = (overrides?: EmailOverrides) =>
  factory.get(overrides);

export const getEmailGateway = (overrides?: EmailOverrides) =>
  getEmailServices(overrides).gateway;

export const getEmailUseCases = (overrides?: EmailOverrides) =>
  getEmailServices(overrides).useCases;

export const getResendWebhookVerifier = (overrides?: EmailOverrides) =>
  getEmailServices(overrides).resendWebhookVerifier;

/** Test-only. */
export const __resetEmailComposition = () => factory.reset();
