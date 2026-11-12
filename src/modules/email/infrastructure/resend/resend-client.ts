import { Resend } from 'resend';

import { AppError } from '@/modules/kernel';

export function createResendClient(apiKey: string | undefined) {
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
