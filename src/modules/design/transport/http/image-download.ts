import { Result } from '@bloodyowl/boxed';
import { match, P } from 'ts-pattern';

import type { AuthSession } from '@/modules/auth';
import { toImageId } from '@/modules/kernel/domain/ids';

import type { DesignUseCases } from '../../factory';

export type ImageDownloadDeps = {
  getCurrentSession: (headers: Headers) => Promise<AuthSession | null>;
  getUseCases: () => Pick<DesignUseCases, 'getImageDownloadUrl'>;
};

const status = (code: number) => new Response(null, { status: code });

/**
 * `GET /api/images/:imageId/download`: verifies the caller owns the image,
 * then redirects to a short-lived signed URL that downloads the stored
 * original. Auth is enforced here, independently of route guards.
 */
export const handleImageDownload = async (
  deps: ImageDownloadDeps,
  input: { request: Request; imageId: string }
): Promise<Response> => {
  const session = await deps.getCurrentSession(input.request.headers);
  if (!session?.user) return status(401);
  const imageId = toImageId(input.imageId);
  if (imageId.isError()) return status(404);

  const result = await deps.getUseCases().getImageDownloadUrl({
    currentUserId: session.user.id,
    imageId: imageId.get(),
  });
  return match(result)
    .with(Result.P.Error(P._), () => status(502))
    .with(
      Result.P.Ok({ type: 'image_download_url', url: P.select() }),
      // Not Response.redirect(): its headers are immutable and the security
      // header middleware must still be able to set headers.
      (url) =>
        new Response(null, {
          status: 302,
          headers: { Location: url, 'Cache-Control': 'no-store' },
        })
    )
    .with(Result.P.Ok({ type: 'image_not_found' }), () => status(404))
    .with(Result.P.Ok({ type: 'design_forbidden' }), () => status(403))
    .exhaustive();
};
