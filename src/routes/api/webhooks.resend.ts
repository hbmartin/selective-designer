import { createFileRoute } from '@tanstack/react-router';

import { getKernel } from '@/composition/kernel';
import { handleResendWebhookRequest } from '@/modules/email/backend';

export const Route = createFileRoute('/api/webhooks/resend')({
  server: {
    handlers: {
      POST: ({ request }) => {
        return handleResendWebhookRequest(request, {
          logger: getKernel().logger,
        });
      },
    },
  },
});
