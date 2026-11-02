import { createFileRoute } from '@tanstack/react-router';

import { isForbiddenRouteContext } from '@/modules/auth/presentation';
import { userQueries } from '@/modules/user/client';
import { PageUserUpdate } from '@/modules/user/presentation';
import { observedLoader } from '@/platform/router/route-observability';
import { parseRouteScopeKey, parseRouteUserId } from '@/routes/-route-params';

export const Route = createFileRoute('/manager/users/$id/update/')({
  loader: observedLoader(
    '/manager/users/$id/update/',
    ({ context, params }) => {
      if (isForbiddenRouteContext(context)) return undefined;

      return context.queryClient.ensureQueryData(
        userQueries.getById({
          id: parseRouteUserId(params.id),
          scopeKey: parseRouteScopeKey(context.scopeKey),
        })
      );
    }
  ),
  component: RouteComponent,
});

function RouteComponent() {
  const params = Route.useParams();
  return <PageUserUpdate userId={parseRouteUserId(params.id)} />;
}
