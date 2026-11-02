import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { designQueries } from '@/modules/design/client';
import { PageDesigns } from '@/modules/design/presentation';
import { observedLoader } from '@/platform/router/route-observability';
import { parseRouteScopeKey } from '@/routes/-route-params';

const defaultSearch = { searchTerm: '', archived: false };

export const Route = createFileRoute('/app/designs/')({
  validateSearch: zodValidator(
    z.object({
      searchTerm: z.string().trim().max(120).prefault(''),
      archived: z.boolean().prefault(false),
    })
  ),
  search: {
    middlewares: [stripSearchParams(defaultSearch)],
  },
  loaderDeps: ({ search: { searchTerm, archived } }) => ({
    searchTerm,
    archived,
  }),
  component: RouteComponent,
  loader: observedLoader('/app/designs/', ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(
      designQueries.getAllInfinite({
        scopeKey: parseRouteScopeKey(context.scopeKey),
        searchTerm: deps.searchTerm,
        archived: deps.archived,
      })
    )
  ),
});

function RouteComponent() {
  const search = Route.useSearch();
  return <PageDesigns search={search} />;
}
