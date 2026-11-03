import { createFileRoute, Link } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { ArrowLeftIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import {
  AppPageLayout as PageLayout,
  AppPageLayoutContent as PageLayoutContent,
  AppPageLayoutTopBar as PageLayoutTopBar,
  AppPageLayoutTopBarTitle as PageLayoutTopBarTitle,
} from '@/platform/components/page-layout';
import { Button } from '@/platform/components/ui/button';

import { renderingQueries } from '@/modules/rendering/client';
import { compareModes, CompareView } from '@/modules/rendering/presentation';
import { observedLoader } from '@/platform/router/route-observability';
import {
  parseRouteDesignId,
  parseRouteImageId,
  parseRouteRenderId,
  parseRouteScopeKey,
} from '@/routes/-route-params';

const zId = () => z.string().trim().min(1).max(64);

export const Route = createFileRoute('/app/designs/$designId/compare')({
  validateSearch: zodValidator(
    z.object({
      a: zId(),
      b: zId(),
      mode: z.enum(compareModes).prefault('side'),
      opacity: z.number().min(0).max(1).prefault(0.5),
      /** With render + result, show the change check for b. */
      render: zId().optional(),
      result: zId().optional(),
    })
  ),
  loaderDeps: ({ search: { a, b } }) => ({ a, b }),
  component: RouteComponent,
  loader: observedLoader(
    '/app/designs/$designId/compare',
    async ({ context, deps }) => {
      const scopeKey = parseRouteScopeKey(context.scopeKey);
      await Promise.all(
        [deps.a, deps.b].map((value) =>
          context.queryClient.ensureQueryData(
            renderingQueries.source({
              scopeKey,
              imageId: parseRouteImageId(value),
            })
          )
        )
      );
    }
  ),
});

function RouteComponent() {
  const { t } = useTranslation(['rendering']);
  const params = Route.useParams();
  const designId = parseRouteDesignId(params.designId);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PageLayout>
      <PageLayoutTopBar
        startActions={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('rendering:review.back')}
            nativeButton={false}
            render={<Link to="/app/designs/$designId" params={{ designId }} />}
          >
            <ArrowLeftIcon />
          </Button>
        }
      >
        <PageLayoutTopBarTitle>
          {t('rendering:compare.title')}
        </PageLayoutTopBarTitle>
      </PageLayoutTopBar>
      <PageLayoutContent className="pb-20">
        <CompareView
          key={JSON.stringify([
            search.a,
            search.b,
            search.render,
            search.result,
          ])}
          a={parseRouteImageId(search.a)}
          b={parseRouteImageId(search.b)}
          mode={search.mode}
          opacity={search.opacity}
          onModeChange={(mode) =>
            navigate({ search: (prev) => ({ ...prev, mode }), replace: true })
          }
          onOpacityChange={(opacity) =>
            navigate({
              search: (prev) => ({ ...prev, opacity }),
              replace: true,
            })
          }
          check={
            search.render && search.result
              ? {
                  renderId: parseRouteRenderId(search.render),
                  resultId: search.result,
                }
              : undefined
          }
        />
      </PageLayoutContent>
    </PageLayout>
  );
}
