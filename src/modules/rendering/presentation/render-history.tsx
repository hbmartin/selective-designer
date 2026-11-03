import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCwIcon, StarIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Badge } from '@/platform/components/ui/badge';
import { Button } from '@/platform/components/ui/button';
import { Spinner } from '@/platform/components/ui/spinner';

import { useCurrentScopeKey } from '@/modules/auth/client';
import type { ImageId } from '@/modules/kernel/domain/ids';

import { renderingQueries } from './wired-queries';
import type {
  RenderResultView,
  RenderView,
} from '../application/use-cases/renders';
import { isTerminalStatus, parseSkipReason } from '../domain/render';

const POLL_MS = 2000;

type ResultActions = (result: RenderResultView) => ReactNode;

const ResultTile = (props: {
  result: RenderResultView;
  preferred: boolean;
  actions?: ResultActions;
}) => {
  const { t } = useTranslation(['rendering']);
  const queryClient = useQueryClient();
  const retry = useMutation({
    ...renderingQueries.retry(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: renderingQueries.all() }),
    onError: () => toast.error(t('rendering:errors.retryFailed')),
  });
  const { result } = props;
  const modelName = t(`rendering:models.${result.modelId}`);
  const skip = result.skipReason ? parseSkipReason(result.skipReason) : null;

  return (
    <li
      className="flex flex-col gap-1 rounded-md border bg-card p-2"
      data-testid="render-result"
      data-model={result.modelId}
      data-status={result.status}
    >
      <div
        className="relative overflow-hidden rounded bg-muted"
        style={{
          aspectRatio: result.outputSize
            ? `${result.outputSize.width} / ${result.outputSize.height}`
            : '4 / 3',
        }}
      >
        {result.outputUrl ? (
          <img
            src={result.outputUrl}
            alt={t('rendering:history.outputAlt', { model: modelName })}
            draggable={false}
            className="size-full object-contain"
          />
        ) : (
          !isTerminalStatus(result.status) && (
            <div className="flex size-full items-center justify-center">
              <Spinner />
            </div>
          )
        )}
      </div>
      <div className="flex items-center justify-between gap-1 text-xs">
        <span className="truncate font-medium">{modelName}</span>
        <span className="flex items-center gap-1">
          {props.preferred && (
            <StarIcon
              className="size-3 fill-current"
              aria-label={t('rendering:history.preferred')}
            />
          )}
          <Badge
            variant={result.status === 'failed' ? 'negative' : 'secondary'}
            className="text-[10px]"
          >
            {t(`rendering:status.${result.status}`)}
          </Badge>
        </span>
      </div>
      {result.status === 'succeeded' && props.actions?.(result)}
      {skip && (
        <p className="text-xs text-muted-foreground">
          {skip.reason === 'too_many_references'
            ? t('rendering:skipReasons.too_many_references', {
                references: skip.references,
                limit: skip.limit,
              })
            : skip.reason}
        </p>
      )}
      {result.status === 'failed' && (
        <div className="flex items-center justify-between gap-1">
          <p
            className="truncate text-xs text-muted-foreground"
            title={result.errorMessage ?? undefined}
          >
            {result.errorMessage}
          </p>
          <Button
            size="xs"
            variant="ghost"
            loading={retry.isPending}
            onClick={() => retry.mutate({ resultId: result.id })}
          >
            <RotateCwIcon />
            {t('rendering:history.retry')}
          </Button>
        </div>
      )}
    </li>
  );
};

const RenderEntry = (props: {
  render: RenderView;
  baseImageId: ImageId;
  actions?: ResultActions;
}) => {
  const { t } = useTranslation(['rendering']);
  const { render } = props;
  return (
    <li className="flex flex-col gap-2" data-testid="render">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <time dateTime={new Date(render.createdAt).toISOString()}>
          {new Date(render.createdAt).toLocaleString()}
        </time>
        {render.batchId && (
          <Badge variant="secondary">{t('rendering:history.batch')}</Badge>
        )}
        {render.renderSourceImageId !== props.baseImageId && (
          <span>{t('rendering:history.fromSource')}</span>
        )}
      </div>
      <ul className="grid grid-cols-2 gap-2">
        {render.results.map((result) => (
          <ResultTile
            key={result.id}
            result={result}
            preferred={render.preferredResultId === result.id}
            actions={props.actions}
          />
        ))}
      </ul>
    </li>
  );
};

/** Every render of the design, newest first, polling while any is running. */
export const RenderHistory = (props: {
  baseImageId: ImageId;
  /** Per-result actions composed by the route (e.g. continue editing). */
  resultActions?: ResultActions;
}) => {
  const { t } = useTranslation(['rendering']);
  const scopeKey = useCurrentScopeKey();
  const rendersQuery = useQuery({
    ...renderingQueries.renders({ scopeKey, imageId: props.baseImageId }),
    refetchInterval: (query) =>
      query.state.data?.some((render) =>
        render.results.some((result) => !isTerminalStatus(result.status))
      )
        ? POLL_MS
        : false,
  });
  const renders = rendersQuery.data ?? [];

  return (
    <section
      aria-label={t('rendering:history.title')}
      className="flex flex-col gap-3"
    >
      <h2 className="text-sm font-medium">{t('rendering:history.title')}</h2>
      {rendersQuery.isPending ? (
        <Spinner />
      ) : renders.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('rendering:history.empty')}
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {renders.map((render) => (
            <RenderEntry
              key={render.id}
              render={render}
              baseImageId={props.baseImageId}
              actions={props.resultActions}
            />
          ))}
        </ol>
      )}
    </section>
  );
};
