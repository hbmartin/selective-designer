import { Resend } from 'resend';

import { AppError } from '@/modules/kernel';
import { getEmailConfig } from '@/modules/kernel/backend';

export function createResendClient(apiKey = getEmailConfig().resendApiKey) {
  if (!apiKey) {
    throw new AppError({
      code: 'EMAIL_RESEND_API_KEY_NOT_CONFIGURED',
      category: 'system',
      status: 500,
      message: 'RESEND_API_KEY is required for Resend email delivery',
    });
  }

  return new Resend(apiKey);
}

let resend: ReturnType<typeof createResendClient> | undefined;

export function getDefaultResendClient() {
  resend ??= createResendClient();
  return resend;
}
