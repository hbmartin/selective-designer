import { createFileRoute } from '@tanstack/react-router';

import { scheduleRenderOutputCleanup } from '@/composition/render-output-cleanup-scheduler';
import {
  getAccountingConfig,
  hasCronAuthority,
} from '@/modules/kernel/backend';

export const Route = createFileRoute('/api/internal/rendering/cleanup')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!hasCronAuthority(request, getAccountingConfig().cronSecret))
          return new Response('Unauthorized', { status: 401 });
        await scheduleRenderOutputCleanup();
        return Response.json(
          { type: 'render_cleanup_scheduled' },
          { status: 202 }
        );
      },
    },
  },
});
