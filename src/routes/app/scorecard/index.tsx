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
      <PageLayoutTopBar>
        <PageLayoutTopBarTitle>
          {t('rendering:scorecard.title')}
        </PageLayoutTopBarTitle>
      </PageLayoutTopBar>
      <PageLayoutContent className="flex max-w-2xl flex-col gap-3 pb-20">
        <p className="text-sm text-muted-foreground">
          {t('rendering:scorecard.description')}
        </p>
        <ModelScorecard />
      </PageLayoutContent>
    </PageLayout>
  );
}
