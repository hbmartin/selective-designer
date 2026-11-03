import { createFileRoute } from '@tanstack/react-router';

import { designQueries } from '@/modules/design/client';
import { PageDesign } from '@/modules/design/presentation';
import { moodboardQueries } from '@/modules/moodboard/client';
import { MoodboardPanel } from '@/modules/moodboard/presentation';
import { RegionsView } from '@/modules/segmentation/presentation';
import { observedLoader } from '@/platform/router/route-observability';
import { parseRouteDesignId, parseRouteScopeKey } from '@/routes/-route-params';

export const Route = createFileRoute('/app/designs/$designId/')({
  component: RouteComponent,
  loader: observedLoader('/app/designs/$designId/', ({ context, params }) => {
    const scopeKey = parseRouteScopeKey(context.scopeKey);
    const designId = parseRouteDesignId(params.designId);
    // Secondary: start the mood board without blocking the design itself.
    void context.queryClient.prefetchQuery(
      moodboardQueries.byDesign({ scopeKey, designId })
    );
    return context.queryClient.ensureQueryData(
      designQueries.getById({ scopeKey, id: designId })
    );
  }),
});

function RouteComponent() {
  const { designId } = Route.useParams();
  const id = parseRouteDesignId(designId);
  return (
    <PageDesign
      designId={id}
      aside={<MoodboardPanel designId={id} />}
      renderBaseImage={(image) => (
        <RegionsView
          imageId={image.id}
          imageUrl={image.workingUrl}
          width={image.working.width}
          height={image.working.height}
        />
      )}
    />
  );
}
