import { createFileRoute, Link } from '@tanstack/react-router';
import { PencilIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/platform/components/ui/button';

import { designQueries } from '@/modules/design/client';
import { PageDesign } from '@/modules/design/presentation';
import { moodboardQueries } from '@/modules/moodboard/client';
import { MoodboardPanel } from '@/modules/moodboard/presentation';
import { RenderHistory } from '@/modules/rendering/presentation';
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
  const { t } = useTranslation(['rendering']);
  const { designId } = Route.useParams();
  const id = parseRouteDesignId(designId);
  return (
    <PageDesign
      designId={id}
      actions={
        <Button
          size="sm"
          nativeButton={false}
          render={
            <Link to="/app/designs/$designId/edit" params={{ designId }} />
          }
        >
          <PencilIcon />
          {t('rendering:history.edit')}
        </Button>
      }
      aside={<MoodboardPanel designId={id} />}
      renderBaseImage={(image) => (
        <>
          <RegionsView
            imageId={image.id}
            imageUrl={image.workingUrl}
            width={image.working.width}
            height={image.working.height}
          />
          <RenderHistory
            baseImageId={image.id}
            resultActions={(result) =>
              result.outputImageId ? (
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
              ) : null
            }
          />
        </>
      )}
    />
  );
}
