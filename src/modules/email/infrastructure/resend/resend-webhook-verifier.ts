import type { WebhookEventPayload } from 'resend';
import { Resend } from 'resend';

import { AppError } from '@/modules/kernel';
import { getResendWebhookConfig } from '@/modules/kernel/backend';

// Verification in the Resend SDK is local and does not use the API key.
let verifier: Resend['webhooks'] | undefined;
const getLocalVerifier = () =>
  (verifier ??= new Resend('webhook-verification').webhooks);

export type VerifyResendWebhookInput = {
  payload: string;
  headers: {
    id: string;
    timestamp: string;
    signature: string;
  };
};

export class ResendWebhookVerifier {
  constructor(private readonly resend?: Resend) {}

  verify(input: VerifyResendWebhookInput): WebhookEventPayload {
    const webhookSecret = getResendWebhookConfig().secret;
    if (!webhookSecret) {
      throw new AppError({
        code: 'EMAIL_WEBHOOK_SECRET_NOT_CONFIGURED',
        category: 'system',
        status: 500,
        message: 'Resend webhook secret is not configured',
      });
    }

    try {
      const verifier = this.resend?.webhooks ?? getLocalVerifier();
      return verifier.verify({
        payload: input.payload,
        headers: input.headers,
        webhookSecret,
      });
    } catch (error) {
      throw new AppError({
        code: 'EMAIL_WEBHOOK_INVALID_SIGNATURE',
        category: 'bad_request',
        status: 400,
        message: 'Invalid email webhook signature',
        cause: error,
      });
    }
  }
}
