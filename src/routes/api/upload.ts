import { createFileRoute } from '@tanstack/react-router';

import { handleUploadRequest, type UploadRoutes } from '@/composition/uploads';

// Typed route names for upload components (one per upload purpose).
export type { UploadRoutes };

export const Route = createFileRoute('/api/upload')({
  server: {
    handlers: {
      POST: ({ request }) => handleUploadRequest(request),
    },
  },
});
