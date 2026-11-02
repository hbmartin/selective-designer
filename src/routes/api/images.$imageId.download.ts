import { createFileRoute } from '@tanstack/react-router';

import { handleImageDownloadRequest } from '@/composition/uploads';

export const Route = createFileRoute('/api/images/$imageId/download')({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        handleImageDownloadRequest(request, params.imageId),
    },
  },
});
