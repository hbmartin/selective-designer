import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import {
  AppPageLayout as PageLayout,
  AppPageLayoutContent as PageLayoutContent,
  AppPageLayoutTopBar as PageLayoutTopBar,
  AppPageLayoutTopBarTitle as PageLayoutTopBarTitle,
} from '@/platform/components/page-layout';

import { renderingQueries } from '@/modules/rendering/client';
import { ModelScorecard } from '@/modules/rendering/presentation';
import { observedLoader } from '@/platform/router/route-observability';
import { parseRouteScopeKey } from '@/routes/-route-params';

export const Route = createFileRoute('/app/scorecard/')({
  component: RouteComponent,
  loader: observedLoader('/app/scorecard/', ({ context }) =>
    context.queryClient.ensureQueryData(
      renderingQueries.scorecard({
        scopeKey: parseRouteScopeKey(context.scopeKey),
      })
    )
  ),
});

function RouteComponent() {
  const { t } = useTranslation(['rendering']);
  return (
    <PageLayout>
      <PageLayoutTopBar containerClassName="max-w-3xl">
        <PageLayoutTopBarTitle>
          {t('rendering:scorecard.title')}
        </PageLayoutTopBarTitle>
      </PageLayoutTopBar>
      <PageLayoutContent className="pb-20" containerClassName="max-w-3xl gap-4">
        <p className="text-sm text-muted-foreground">
          {t('rendering:scorecard.description')}
        </p>
        <ModelScorecard />
      </PageLayoutContent>
    </PageLayout>
  );
}
