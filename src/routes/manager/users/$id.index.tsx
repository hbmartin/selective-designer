import { createFileRoute } from '@tanstack/react-router';

import { isForbiddenRouteContext } from '@/modules/auth/presentation';
import { userQueries } from '@/modules/user/client';
import { PageUser } from '@/modules/user/presentation';
import { observedLoader } from '@/platform/router/route-observability';
import { parseRouteScopeKey, parseRouteUserId } from '@/routes/-route-params';

export const Route = createFileRoute('/manager/users/$id/')({
  loader: observedLoader('/manager/users/$id/', ({ context, params }) => {
    if (isForbiddenRouteContext(context)) return undefined;
    const scopeKey = parseRouteScopeKey(context.scopeKey);
    const userId = parseRouteUserId(params.id);

    const userPromise = context.queryClient.ensureQueryData(
      userQueries.getById({ id: userId, scopeKey })
    );

    // eslint-disable-next-line sonarjs/void-use -- Secondary data must not block the critical route query.
    void context.queryClient.prefetchInfiniteQuery(
      userQueries.getUserSessionsInfinite({
        limit: 5,
        scopeKey,
        userId,
      })
    );

    return userPromise;
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const params = Route.useParams();
  return <PageUser userId={parseRouteUserId(params.id)} />;
}
