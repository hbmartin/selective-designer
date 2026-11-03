import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  AppPageLayout as PageLayout,
  AppPageLayoutContent as PageLayoutContent,
  AppPageLayoutTopBar as PageLayoutTopBar,
  AppPageLayoutTopBarTitle as PageLayoutTopBarTitle,
} from '@/platform/components/page-layout';
import { Button } from '@/platform/components/ui/button';

import { useCurrentScopeKey } from '@/modules/auth/client';
import { designQueries } from '@/modules/design/client';
import { renderingQueries } from '@/modules/rendering/client';
import { RenderResults } from '@/modules/rendering/presentation';
import { observedLoader } from '@/platform/router/route-observability';
import {
  parseRouteDesignId,
  parseRouteRenderId,
  parseRouteScopeKey,
} from '@/routes/-route-params';

export const Route = createFileRoute(
  '/app/designs/$designId/renders/$renderId'
)({
  component: RouteComponent,
  loader: observedLoader(
    '/app/designs/$designId/renders/$renderId',
    async ({ context, params }) => {
      const scopeKey = parseRouteScopeKey(context.scopeKey);
      const designId = parseRouteDesignId(params.designId);
      const renderId = parseRouteRenderId(params.renderId);
      await Promise.all([
        context.queryClient.ensureQueryData(
          designQueries.getById({ scopeKey, id: designId })
        ),
        context.queryClient.ensureQueryData(
          renderingQueries.render({ scopeKey, renderId })
        ),
      ]);
    }
  ),
});

function RouteComponent() {
  const { t } = useTranslation(['rendering']);
  const params = Route.useParams();
  const designId = parseRouteDesignId(params.designId);
  const renderId = parseRouteRenderId(params.renderId);
  const scopeKey = useCurrentScopeKey();
  const navigate = useNavigate();
  const design = useQuery(designQueries.getById({ scopeKey, id: designId }));
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
          {t('rendering:review.title')}
        </PageLayoutTopBarTitle>
      </PageLayoutTopBar>
      <PageLayoutContent className="pb-20">
        {design.data && (
          <RenderResults
            renderId={renderId}
            baseImageId={design.data.baseImage.id}
            resultActions={(result, render) =>
              result.outputImageId ? (
                <>
                  <Button
                    size="xs"
                    variant="ghost"
                    nativeButton={false}
                    render={
                      <Link
                        to="/app/designs/$designId/compare"
                        params={{ designId }}
                        search={{
                          a: render.renderSourceImageId,
                          b: result.outputImageId,
                          render: render.id,
                          result: result.id,
                        }}
                      />
                    }
                  >
                    {t('rendering:review.compare')}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    nativeButton={false}
                    render={
                      <Link
                        to="/app/designs/$designId/edit"
                        params={{ designId }}
                        search={{ sourceImageId: result.outputImageId }}
                      />
                    }
                  >
                    {t('rendering:history.continue')}
                  </Button>
                </>
              ) : null
            }
            onRebuilt={() =>
              navigate({
                to: '/app/designs/$designId/edit',
                params: { designId },
              })
            }
          />
        )}
      </PageLayoutContent>
    </PageLayout>
  );
}
