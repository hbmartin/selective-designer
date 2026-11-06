import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, RotateCwIcon, StarIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Badge } from '@/platform/components/ui/badge';
import { Button } from '@/platform/components/ui/button';
import { ConfirmResponsiveDrawer } from '@/platform/components/ui/confirm-responsive-drawer';
import { Input } from '@/platform/components/ui/input';
import { Skeleton } from '@/platform/components/ui/skeleton';
import { Spinner } from '@/platform/components/ui/spinner';

import { useCurrentScopeKey } from '@/modules/auth/client';
import type { ImageId, RenderId } from '@/modules/kernel/domain/ids';

import { ChangeCheckBadge } from './change-check-badge';
import { useChangeCheck } from './use-change-check';
import { renderingQueries } from '../wired-queries';
import type {
  RenderResultView,
  RenderView,
} from '../../application/use-cases/renders';
import type { RecipeEdit } from '../../domain/recipe';
import { isTerminalStatus, parseSkipReason } from '../../domain/render';
import type { RebuiltDraftResponse } from '../../transport/http/rendering-handlers';

const POLL_MS = 2000;

const describe = (
  edit: RecipeEdit,
  t: (key: never, options?: object) => string
) => {
  switch (edit.kind) {
    case 'placement':
      return t('rendering:edits.placement' as never, { item: edit.item.name });
    case 'replacement':
      return t('rendering:edits.replacement' as never, {
        region: edit.region.label,
        item: edit.item.name,
      });
    case 'removal':
      return t('rendering:edits.removal' as never, {
        region: edit.region.label,
      });
    case 'material':
      return t('rendering:edits.material' as never, {
        region: edit.region.label,
        material: edit.swatch?.name ?? edit.text,
      });
  }
};

const SchemeName = (props: { result: RenderResultView }) => {
  const { t } = useTranslation(['rendering']);
  const queryClient = useQueryClient();
  const [value, setValue] = useState(props.result.schemeName ?? '');
  const save = useMutation({
    ...renderingQueries.nameScheme(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: renderingQueries.all() }),
  });
  const commit = () => {
    const name = value.trim();
    if (name === (props.result.schemeName ?? '')) return;
    save.mutate({ resultId: props.result.id, name: name || null });
  };
  return (
    <Input
      size="sm"
      value={value}
      placeholder={t('rendering:review.schemePlaceholder')}
      aria-label={t('rendering:review.schemeName')}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
};

const ResultCard = (props: {
  render: RenderView;
  result: RenderResultView;
  actions?: (result: RenderResultView) => ReactNode;
}) => {
  const { t } = useTranslation(['rendering']);
  const queryClient = useQueryClient();
  const [heatmap, setHeatmap] = useState(false);
  const { result, render } = props;
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: renderingQueries.all() });
  const prefer = useMutation({
    ...renderingQueries.prefer(),
    onSuccess: invalidate,
  });
  const retry = useMutation({
    ...renderingQueries.retry(),
    onSuccess: invalidate,
  });
  const check = useChangeCheck({
    resultId: result.id,
    sourceUrl: render.sourceUrl,
    resultUrl: result.status === 'succeeded' ? result.outputUrl : null,
    maskUrl: render.editMaskUrl,
    framingChanged: result.framingChanged,
  });
  const preferred = render.preferredResultId === result.id;
  const skip = result.skipReason ? parseSkipReason(result.skipReason) : null;
  const heatmapUrl =
    check.data?.status === 'ready' ? check.data.heatmapUrl : null;

  return (
    <li
      className="flex flex-col gap-2 rounded-lg border bg-card p-3"
      data-testid="result-card"
      data-model={result.modelId}
      data-status={result.status}
      data-preferred={preferred}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">
          {t(`rendering:models.${result.modelId}`)}
        </h3>
        <div className="flex items-center gap-1">
          {result.framingChanged && (
            <Badge variant="warning" className="text-[10px]">
              {t('rendering:review.framingChanged')}
            </Badge>
          )}
          <Badge
            variant={result.status === 'failed' ? 'negative' : 'secondary'}
            className="text-[10px]"
          >
            {t(`rendering:status.${result.status}`)}
          </Badge>
          {result.status === 'succeeded' && (
            <Button
              size="icon-sm"
              variant={preferred ? 'secondary' : 'ghost'}
              aria-pressed={preferred}
              aria-label={
                preferred
                  ? t('rendering:review.unprefer')
                  : t('rendering:review.prefer')
              }
              loading={prefer.isPending}
              onClick={() =>
                prefer.mutate({ resultId: result.id, preferred: !preferred })
              }
            >
              <StarIcon className={preferred ? 'fill-current' : undefined} />
            </Button>
          )}
        </div>
      </div>
      <div
        className="relative overflow-hidden rounded-md bg-muted"
        style={{
          aspectRatio: result.outputSize
            ? `${result.outputSize.width} / ${result.outputSize.height}`
            : render.sourceSize
              ? `${render.sourceSize.width} / ${render.sourceSize.height}`
              : '4 / 3',
        }}
      >
        {result.outputUrl ? (
          <img
            src={heatmap && heatmapUrl ? heatmapUrl : result.outputUrl}
            alt={t('rendering:history.outputAlt', {
              model: t(`rendering:models.${result.modelId}`),
            })}
            className="size-full object-contain"
            draggable={false}
          />
        ) : (
          !isTerminalStatus(result.status) && (
            <div className="flex size-full items-center justify-center">
              <Spinner />
            </div>
          )
        )}
      </div>
      {result.status === 'succeeded' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ChangeCheckBadge check={check.data} />
          {heatmapUrl && (
            <Button
              size="xs"
              variant="ghost"
              aria-pressed={heatmap}
              onClick={() => setHeatmap((v) => !v)}
            >
              {heatmap
                ? t('rendering:check.hideHeatmap')
                : t('rendering:check.heatmap')}
            </Button>
          )}
        </div>
      )}
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
        <div className="flex items-center justify-between gap-2">
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
      {result.status === 'succeeded' && (
        <>
          <SchemeName key={result.schemeName ?? ''} result={result} />
          <div className="flex flex-wrap items-center gap-1">
            {result.outputImageId && (
              <Button
                size="xs"
                variant="ghost"
                nativeButton={false}
                // oxlint-disable-next-line jsx-a11y/anchor-has-content -- Button renders the label.
                render={
                  <a href={`/api/images/${result.outputImageId}/download`} />
                }
              >
                <DownloadIcon />
                {t('rendering:review.download')}
              </Button>
            )}
            {props.actions?.(result)}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs text-muted-foreground">
            <dt>{t('rendering:review.modelVersion')}</dt>
            <dd className="truncate">{result.modelVersion ?? '—'}</dd>
            <dt>{t('rendering:review.cost')}</dt>
            <dd>
              {result.costUsdMicros !== null
                ? `$${(result.costUsdMicros / 1_000_000).toFixed(2)} (${result.costSource})`
                : t('rendering:review.costUnavailable')}
            </dd>
          </dl>
        </>
      )}
    </li>
  );
};

/** One render's results side by side, with review actions. */
export const RenderResults = (props: {
  renderId: RenderId;
  baseImageId: ImageId;
  resultActions?: (result: RenderResultView, render: RenderView) => ReactNode;
  onRebuilt?: (outcome: RebuiltDraftResponse) => void;
}) => {
  const { t } = useTranslation(['rendering']);
  const scopeKey = useCurrentScopeKey();
  const renderQuery = useQuery({
    ...renderingQueries.render({ scopeKey, renderId: props.renderId }),
    refetchInterval: (query) =>
      query.state.data?.results.some(
        (result) => !isTerminalStatus(result.status)
      )
        ? POLL_MS
        : false,
  });
  const queryClient = useQueryClient();
  const rebuild = useMutation({
    ...renderingQueries.draftFromOriginal(),
    onSuccess: async (outcome) => {
      if (outcome.type !== 'draft_rebuilt') return;
      await queryClient.invalidateQueries({ queryKey: renderingQueries.all() });
      toast.success(t('rendering:review.rebuilt', { count: outcome.edits }));
      const { unmappableRegion, editLimit } = outcome.omitted;
      const reasons = [];
      if (unmappableRegion > 0)
        reasons.push(
          t('rendering:review.omittedRegion', { count: unmappableRegion })
        );
      if (editLimit > 0)
        reasons.push(t('rendering:review.omittedLimit', { count: editLimit }));
      if (reasons.length > 0)
        toast.warning(t('rendering:review.editsOmitted'), {
          description: reasons.join(' '),
        });
      props.onRebuilt?.(outcome);
    },
  });
  const render = renderQuery.data;
  if (renderQuery.isError)
    return (
      <p className="text-sm text-muted-foreground">
        {t('rendering:review.notFound')}
      </p>
    );
  if (!render) return <Skeleton className="aspect-video w-full" />;
  const continued = render.renderSourceImageId !== props.baseImageId;

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-wrap items-start gap-4 rounded-lg border bg-card p-3">
        {render.sourceUrl && (
          <img
            src={render.sourceUrl}
            alt={t('rendering:history.sourceAlt')}
            className="h-20 rounded border object-contain"
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <h2 className="font-medium">{t('rendering:review.recipe')}</h2>
          <ol
            className="list-inside list-decimal text-muted-foreground"
            data-testid="recipe-edits"
          >
            {render.recipe.edits.map((edit) => (
              <li key={edit.id}>{describe(edit, t as never)}</li>
            ))}
          </ol>
          {render.recipe.prompt && (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">
                {t('rendering:review.notes')}:{' '}
              </span>
              {render.recipe.prompt}
            </p>
          )}
        </div>
        {continued && (
          <ConfirmResponsiveDrawer
            title={t('rendering:review.rebuild')}
            description={t('rendering:review.rebuildConfirm')}
            confirmText={t('rendering:review.rebuild')}
            confirmAction={async () => {
              try {
                const outcome = await rebuild.mutateAsync({
                  renderId: render.id,
                });
                if (outcome.type === 'draft_rebuilt') return;
                toast.error(t('rendering:review.rebuildConflict'));
              } catch {
                toast.error(t('rendering:review.rebuildFailed'));
              }
              return 'keep_open';
            }}
          >
            <Button size="sm" variant="secondary" loading={rebuild.isPending}>
              {t('rendering:review.rebuild')}
            </Button>
          </ConfirmResponsiveDrawer>
        )}
      </section>
      <ul className="grid gap-4 md:grid-cols-2">
        {render.results.map((result) => (
          <ResultCard
            key={result.id}
            render={render}
            result={result}
            actions={
              props.resultActions
                ? (r) => props.resultActions?.(r, render)
                : undefined
            }
          />
        ))}
      </ul>
    </div>
  );
};
