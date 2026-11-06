import { createFileRoute } from '@tanstack/react-router';

import { scheduleAccountingReconciliation } from '@/composition/accounting-scheduler';
import {
  getAccountingConfig,
  handleAccountingReconcile,
} from '@/modules/kernel/backend';

export const Route = createFileRoute('/api/internal/accounting/reconcile')({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleAccountingReconcile(request, {
          secret: getAccountingConfig().cronSecret,
          start: scheduleAccountingReconciliation,
        }),
    },
  },
});
