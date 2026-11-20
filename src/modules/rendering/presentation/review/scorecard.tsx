import { useQuery } from '@tanstack/react-query';
import { TrophyIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Card } from '@/platform/components/ui/card';
import { EmptyState } from '@/platform/components/ui/empty-state';
import { Skeleton } from '@/platform/components/ui/skeleton';

import { useCurrentScopeKey } from '@/modules/auth/client';

import { renderingQueries } from '../wired-queries';
import { isModelId } from '../../domain/model-catalog';

/** How often each model's result was preferred, across all designs. */
export const ModelScorecard = () => {
  const { t } = useTranslation(['rendering']);
  const scopeKey = useCurrentScopeKey();
  const scorecard = useQuery(renderingQueries.scorecard({ scopeKey }));
  if (!scorecard.data) return <Skeleton className="h-48 w-full rounded-xl" />;
  const rows = scorecard.data.filter((row) => isModelId(row.modelId));
  if (!rows.some((row) => row.preferred > 0)) {
    return (
      <EmptyState
        icon={<TrophyIcon />}
        title={t('rendering:scorecard.emptyTitle')}
        description={t('rendering:scorecard.empty')}
      />
    );
  }
  return (
    <Card className="overflow-x-auto py-0">
      <table className="w-full text-sm" data-testid="scorecard">
        <thead className="border-b text-left text-xs tracking-wide text-muted-foreground uppercase">
          <tr>
            <th className="px-4 py-3 font-medium">
              {t('rendering:scorecard.model')}
            </th>
            <th className="px-4 py-3 text-right font-medium">
              {t('rendering:scorecard.finished')}
            </th>
            <th className="px-4 py-3 text-right font-medium">
              {t('rendering:scorecard.preferred')}
            </th>
            <th className="px-4 py-3 text-right font-medium">
              {t('rendering:scorecard.rate')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => {
            const rate =
              row.contested > 0
                ? Math.round((row.preferred / row.contested) * 100)
                : null;
            return (
              <tr key={row.modelId} data-model={row.modelId}>
                <td className="px-4 py-3 font-medium">
                  {t(`rendering:models.${row.modelId}` as never)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {row.succeeded}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {row.preferred}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {rate === null ? (
                    '—'
                  ) : (
                    <span className="inline-flex items-center justify-end gap-2">
                      <span
                        aria-hidden
                        className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block"
                      >
                        <span
                          className="block h-full rounded-full bg-brand"
                          style={{ width: `${rate}%` }}
                        />
                      </span>
                      {`${rate}%`}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
};
