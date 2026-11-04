import { createFileRoute, notFound } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { DesignEditor } from '@/app/workspace/presentation';
import { designQueries } from '@/modules/design/client';
import { moodboardQueries } from '@/modules/moodboard/client';
import { renderingQueries } from '@/modules/rendering/client';
import { segmentationQueries } from '@/modules/segmentation/client';
import { observedLoader } from '@/platform/router/route-observability';
import {
  parseRouteDesignId,
  parseRouteImageId,
  parseRouteScopeKey,
} from '@/routes/-route-params';

export const Route = createFileRoute('/app/designs/$designId/edit')({
  validateSearch: zodValidator(
    z.object({
      /** A render result to continue from; the base image when absent. */
      sourceImageId: z.string().trim().min(1).max(64).optional(),
    })
  ),
  loaderDeps: ({ search: { sourceImageId } }) => ({ sourceImageId }),
  component: RouteComponent,
  loader: observedLoader(
    '/app/designs/$designId/edit',
    async ({ context, params, deps, cause }) => {
      const scopeKey = parseRouteScopeKey(context.scopeKey);
      const designId = parseRouteDesignId(params.designId);
      // Secondary data starts first and does not block.
      void context.queryClient.prefetchQuery(
        moodboardQueries.byDesign({ scopeKey, designId })
      );
      const knownSource = deps.sourceImageId
        ? parseRouteImageId(deps.sourceImageId)
        : null;
      const prefetchRegions = (imageId: NonNullable<typeof knownSource>) =>
        void segmentationQueries.prefetchEditorRegions(
          context.queryClient,
          { scopeKey, imageId },
          cause !== 'preload'
        );
      if (knownSource) prefetchRegions(knownSource);
      // Critical: the design, then the render source and its draft.
      const design = await context.queryClient.ensureQueryData(
        designQueries.getById({ scopeKey, id: designId })
      );
      const imageId = knownSource ?? design.baseImage.id;
      if (!knownSource) prefetchRegions(imageId);
      const [source] = await Promise.all([
        context.queryClient.ensureQueryData(
          renderingQueries.source({ scopeKey, imageId })
        ),
        context.queryClient.ensureQueryData(
          renderingQueries.draft({ scopeKey, imageId })
        ),
      ]);
      // A render source from another design does not belong on this page.
      if (source.designId !== designId) throw notFound();
      return { imageId };
    }
  ),
});

function RouteComponent() {
  const { designId } = Route.useParams();
  const { imageId } = Route.useLoaderData();
  return (
    <DesignEditor
      key={imageId}
      designId={parseRouteDesignId(designId)}
      sourceImageId={imageId}
    />
  );
}
