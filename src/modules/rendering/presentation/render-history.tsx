import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCwIcon, StarIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useHydrated } from '@/platform/hooks/use-hydrated';

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
      {result.retryable && (
        <p className="text-xs text-muted-foreground">
          {t('rendering:history.retryHint')}
        </p>
      )}
      {result.retryable && (
        <div className="flex items-center justify-between gap-1">
          <p
            className="truncate text-xs text-muted-foreground"
            title={result.errorMessage ?? undefined}
          >
            {result.status === 'failed'
              ? result.errorMessage
              : t('rendering:history.delayed')}
          </p>
          <Button
            size="xs"
            variant="ghost"
            title={t('rendering:history.retryHint')}
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

type RenderNode = { render: RenderView; children: RenderNode[] };

/** Renders continued from a result nest under the render that produced it. */
const buildTree = (renders: readonly RenderView[]): RenderNode[] => {
  const nodes = new Map(
    renders.map((render) => [
      render.id,
      { render, children: [] as RenderNode[] },
    ])
  );
  const producedBy = new Map<string, RenderView['id']>();
  for (const render of renders) {
    for (const result of render.results) {
      if (result.outputImageId) producedBy.set(result.outputImageId, render.id);
    }
  }
  const roots: RenderNode[] = [];
  for (const render of renders) {
    const node = nodes.get(render.id);
    if (!node) continue;
    const parentId = producedBy.get(render.renderSourceImageId);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
};

const RenderEntry = (props: {
  node: RenderNode;
  depth: number;
  actions?: ResultActions;
  renderLink?: (render: RenderView) => ReactNode;
}) => {
  const { t } = useTranslation(['rendering']);
  const { render } = props.node;
  const hydrated = useHydrated();
  const createdAt = new Date(render.createdAt);
  const timestamp = createdAt.toISOString();
  return (
    <li
      className={
        props.depth > 0
          ? 'flex flex-col gap-2 border-l-2 pl-3'
          : 'flex flex-col gap-2'
      }
      data-testid="render"
      data-depth={props.depth}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {render.sourceUrl && (
          <img
            src={render.sourceUrl}
            alt={t('rendering:history.sourceAlt')}
            className="h-8 rounded border object-contain"
          />
        )}
        <time dateTime={timestamp}>
          {hydrated ? createdAt.toLocaleString() : timestamp}
        </time>
        {render.batchId && (
          <Badge variant="secondary">{t('rendering:history.batch')}</Badge>
        )}
        {props.depth > 0 && <span>{t('rendering:history.fromSource')}</span>}
        <span className="ml-auto">{props.renderLink?.(render)}</span>
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
      {props.node.children.length > 0 && (
        <ol className="flex flex-col gap-4">
          {props.node.children.map((child) => (
            <RenderEntry
              key={child.render.id}
              node={child}
              depth={props.depth + 1}
              actions={props.actions}
              renderLink={props.renderLink}
            />
          ))}
        </ol>
      )}
    </li>
  );
};

/** Every render of the design, newest first, polling while any is running. */
export const RenderHistory = (props: {
  baseImageId: ImageId;
  /** Per-result actions composed by the route (e.g. continue editing). */
  resultActions?: ResultActions;
  /** Link to a render's results page, composed by the route. */
  renderLink?: (render: RenderView) => ReactNode;
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
          {buildTree(renders).map((node) => (
            <RenderEntry
              key={node.render.id}
              node={node}
              depth={0}
              actions={props.resultActions}
              renderLink={props.renderLink}
            />
          ))}
        </ol>
      )}
    </section>
  );
};
