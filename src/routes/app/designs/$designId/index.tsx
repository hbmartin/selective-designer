import { createFileRoute } from '@tanstack/react-router';

import { designQueries } from '@/modules/design/client';
import { PageDesign } from '@/modules/design/presentation';
import { observedLoader } from '@/platform/router/route-observability';
import { parseRouteDesignId, parseRouteScopeKey } from '@/routes/-route-params';

export const Route = createFileRoute('/app/designs/$designId/')({
  component: RouteComponent,
  loader: observedLoader('/app/designs/$designId/', ({ context, params }) =>
    context.queryClient.ensureQueryData(
      designQueries.getById({
        scopeKey: parseRouteScopeKey(context.scopeKey),
        id: parseRouteDesignId(params.designId),
      })
    )
  ),
});

function RouteComponent() {
  const { designId } = Route.useParams();
  return <PageDesign designId={parseRouteDesignId(designId)} />;
}
