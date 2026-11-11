import type { Logger, TransactionRunner } from '@/modules/kernel';
import {
  appErrorToResponse,
  createTransactionRunner,
  getDefaultDbClient,
  getHttpConfig,
  getResendWebhookConfig,
} from '@/modules/kernel/backend';

import { createEmailUseCases, type EmailTransactionContext } from './index';
import { createEmailStatusRepository } from './infrastructure/drizzle/email-status-repository-drizzle';
import { EmailGatewayResend } from './infrastructure/resend/email-gateway-resend';
import { ResendWebhookVerifier } from './infrastructure/resend/resend-webhook-verifier';
import { EmailGatewaySmtp } from './infrastructure/smtp/email-gateway-smtp';
import { createResendWebhookHandlers } from './transport/http/resend-webhook-handlers';

export {
  createEmailStatusRepository,
  EmailGatewayResend,
  EmailGatewaySmtp,
  ResendWebhookVerifier,
};

/**
 * Telemetry-backed observability is injected by the caller (the HTTP route
 * sources it from `getKernel().logger`). This server gate stays free of the
 * telemetry service-locator and of `@/composition`, which would otherwise form
 * a dependency cycle through `composition/email`.
 */
export type ResendWebhookRequestDeps = {
  logger?: Pick<Logger, 'warn'>;
};

/**
 * Wraps a base transaction runner so each transaction exposes an
 * `emailStatusRepository` bound to that transaction. Shared with
 * `composition/email.ts` (consumed through this public gate) so the wiring lives
 * in one place; the default base targets the default DB client.
 */
export const createEmailStatusTransactionRunner = (
  base: ReturnType<typeof createTransactionRunner> = createTransactionRunner(
    getDefaultDbClient()
  )
): TransactionRunner<EmailTransactionContext> => ({
  run: (work, options) =>
    base.run(
      (tx) =>
        work({
          emailStatusRepository: createEmailStatusRepository({ db: tx }),
        }),
      options
    ),
});

const createDefaultEmailUseCases = () => {
  const db = getDefaultDbClient();
  return createEmailUseCases({
    emailStatusRepository: createEmailStatusRepository({ db }),
    transactionRunner: createEmailStatusTransactionRunner(),
  });
};

export async function handleResendWebhookRequest(
  request: Request,
  deps: ResendWebhookRequestDeps = {}
) {
  try {
    const { secret, maxBodyBytes } = getResendWebhookConfig();
    if (!secret) return new Response(null, { status: 404 });
    const handlers = createResendWebhookHandlers({
      getUseCases: createDefaultEmailUseCases,
      logger: deps.logger,
      maxBodyBytes,
      trustedProxyDepth: getHttpConfig().trustedProxyDepth,
      verifier: new ResendWebhookVerifier(),
    });
    return await handlers.receive(request);
  } catch (error) {
    return appErrorToResponse(error);
  }
}
