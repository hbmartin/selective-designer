import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { Skeleton } from '@/platform/components/ui/skeleton';

import { useCurrentScopeKey } from '@/modules/auth/client';

import { renderingQueries } from '../wired-queries';
import { isModelId } from '../../domain/model-catalog';

/** How often each model's result was preferred, across all designs. */
export const ModelScorecard = () => {
  const { t } = useTranslation(['rendering']);
  const scopeKey = useCurrentScopeKey();
  const scorecard = useQuery(renderingQueries.scorecard({ scopeKey }));
  if (!scorecard.data) return <Skeleton className="h-40 w-full" />;
  const rows = scorecard.data.filter((row) => isModelId(row.modelId));
  if (!rows.some((row) => row.preferred > 0)) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('rendering:scorecard.empty')}
      </p>
    );
  }
  return (
    <table className="w-full text-sm" data-testid="scorecard">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          <th className="py-2 font-medium">{t('rendering:scorecard.model')}</th>
          <th className="py-2 text-right font-medium">
            {t('rendering:scorecard.finished')}
          </th>
          <th className="py-2 text-right font-medium">
            {t('rendering:scorecard.preferred')}
          </th>
          <th className="py-2 text-right font-medium">
            {t('rendering:scorecard.rate')}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.modelId} className="border-t" data-model={row.modelId}>
            <td className="py-2">
              {t(`rendering:models.${row.modelId}` as never)}
            </td>
            <td className="py-2 text-right tabular-nums">{row.succeeded}</td>
            <td className="py-2 text-right tabular-nums">{row.preferred}</td>
            <td className="py-2 text-right tabular-nums">
              {row.contested > 0
                ? `${Math.round((row.preferred / row.contested) * 100)}%`
                : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
