import { createFileRoute } from '@tanstack/react-router';

import { scheduleRenderOutputCleanup } from '@/composition/render-output-cleanup-scheduler';
import {
  getAccountingConfig,
  handleAccountingReconcile,
} from '@/modules/kernel/backend';

export const Route = createFileRoute('/api/internal/rendering/cleanup')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const response = await handleAccountingReconcile(request, {
          secret: getAccountingConfig().cronSecret,
          start: scheduleRenderOutputCleanup,
        });
        return response.status === 202
          ? Response.json({ type: 'render_cleanup_scheduled' }, { status: 202 })
          : response;
      },
    },
  },
});
