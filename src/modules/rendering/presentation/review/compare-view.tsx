import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useRef, useState } from 'react';
import {
  ReactCompareSlider,
  ReactCompareSliderImage,
} from 'react-compare-slider';
import { useTranslation } from 'react-i18next';
import {
  type ReactZoomPanPinchRef,
  TransformComponent,
  TransformWrapper,
} from 'react-zoom-pan-pinch';

import { Button } from '@/platform/components/ui/button';
import { Skeleton } from '@/platform/components/ui/skeleton';

import { useCurrentScopeKey } from '@/modules/auth/client';
import type { ImageId, RenderId } from '@/modules/kernel/domain/ids';

import { ChangeCheckBadge } from './change-check-badge';
import { type CompareMode, compareModes } from './compare-modes';
import { useChangeCheck } from './use-change-check';
import { renderingQueries } from '../wired-queries';
import type { RenderSourceView } from '../../application/use-cases/renders';

type Pane = { url: string; width: number; height: number };

/** Two zoomable panes kept in lockstep. */
const SideBySide = (props: { a: Pane; b: Pane; labels: [string, string] }) => {
  const { t } = useTranslation(['rendering']);
  const refs = [
    useRef<ReactZoomPanPinchRef>(null),
    useRef<ReactZoomPanPinchRef>(null),
  ];
  const syncing = useRef(false);
  const sync =
    (from: 0 | 1) =>
    (
      _ref: ReactZoomPanPinchRef,
      state: { scale: number; positionX: number; positionY: number }
    ) => {
      if (syncing.current) return;
      syncing.current = true;
      void refs[from === 0 ? 1 : 0]?.current?.setTransform(
        state.positionX,
        state.positionY,
        state.scale,
        0
      );
      syncing.current = false;
    };
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 md:grid-cols-2">
        {([props.a, props.b] as const).map((pane, index) => (
          <figure
            key={index === 0 ? 'before' : 'after'}
            className="flex min-w-0 flex-col gap-1"
          >
            <div
              className="overflow-hidden rounded-md border bg-muted"
              style={{ aspectRatio: `${pane.width} / ${pane.height}` }}
            >
              <TransformWrapper
                ref={refs[index]}
                minScale={1}
                maxScale={8}
                onTransform={sync(index as 0 | 1)}
              >
                <TransformComponent
                  wrapperClass="!size-full"
                  contentClass="!size-full"
                >
                  <img
                    src={pane.url}
                    alt={props.labels[index]}
                    className="size-full object-contain"
                    draggable={false}
                  />
                </TransformComponent>
              </TransformWrapper>
            </div>
            <figcaption className="text-xs text-muted-foreground">
              {props.labels[index]}
            </figcaption>
          </figure>
        ))}
      </div>
      <Button
        size="xs"
        variant="ghost"
        className="self-start"
        onClick={() => {
          for (const ref of refs) void ref.current?.resetTransform(0);
        }}
      >
        {t('rendering:compare.resetZoom')}
      </Button>
    </div>
  );
};

const CompareWithCheck = (
  props: CompareProps & { check: NonNullable<CompareProps['check']> }
) => {
  const { t } = useTranslation(['rendering']);
  const scopeKey = useCurrentScopeKey();
  const render = useQuery(
    renderingQueries.render({ scopeKey, renderId: props.check.renderId })
  );
  const result = render.data?.results.find(
    (r) => r.id === props.check.resultId
  );
  const check = useChangeCheck({
    resultId: props.check.resultId,
    sourceUrl: render.data?.sourceUrl ?? null,
    resultUrl: result?.outputUrl ?? null,
    maskUrl: render.data?.editMaskUrl ?? null,
    framingChanged: result?.framingChanged ?? false,
  });
  const [shown, setShown] = useState(false);
  const heatmapUrl =
    check.data?.status === 'ready' ? check.data.heatmapUrl : null;
  if (shown && !heatmapUrl) setShown(false);
  const controls = (
    <div className="ml-auto flex items-center gap-2">
      <ChangeCheckBadge check={check.data} />
      {heatmapUrl && (
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={shown}
          onClick={() => setShown(!shown)}
        >
          {shown
            ? t('rendering:check.hideHeatmap')
            : t('rendering:check.heatmap')}
        </Button>
      )}
    </div>
  );
  return (
    <ComparePanes
      {...props}
      controls={controls}
      heatmapUrl={shown ? heatmapUrl : null}
    />
  );
};

const toPane = (source: RenderSourceView | undefined): Pane | null =>
  source
    ? { url: source.url, width: source.width, height: source.height }
    : null;

/**
 * Compare a render source with a result: side by side (synced zoom), swipe
 * or onion skin. With `check`, the advisory change check and its heatmap.
 */
type CompareProps = {
  a: ImageId;
  b: ImageId;
  mode: CompareMode;
  opacity: number;
  onModeChange: (mode: CompareMode) => void;
  onOpacityChange: (opacity: number) => void;
  check?: { renderId: RenderId; resultId: string };
};

const ComparePanes = (
  props: CompareProps & { controls?: ReactNode; heatmapUrl?: string | null }
) => {
  const { t } = useTranslation(['rendering']);
  const scopeKey = useCurrentScopeKey();
  const a = useQuery(renderingQueries.source({ scopeKey, imageId: props.a }));
  const b = useQuery(renderingQueries.source({ scopeKey, imageId: props.b }));
  const paneA = toPane(a.data);
  const paneB = toPane(b.data);
  const shownB =
    paneB && props.heatmapUrl ? { ...paneB, url: props.heatmapUrl } : paneB;
  const labels: [string, string] = [
    t('rendering:compare.before'),
    t('rendering:compare.after'),
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex gap-1"
          role="radiogroup"
          aria-label={t('rendering:compare.title')}
        >
          {compareModes.map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={props.mode === mode ? 'secondary' : 'ghost'}
              role="radio"
              aria-checked={props.mode === mode}
              onClick={() => props.onModeChange(mode)}
            >
              {t(`rendering:compare.modes.${mode}`)}
            </Button>
          ))}
        </div>
        {props.mode === 'onion' && (
          <label className="flex items-center gap-2 text-sm">
            {t('rendering:compare.opacity')}
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={props.opacity}
              onChange={(event) =>
                props.onOpacityChange(Number(event.target.value))
              }
            />
          </label>
        )}
        {props.controls}
      </div>

      {!paneA || !shownB ? (
        <Skeleton className="aspect-video w-full" />
      ) : props.mode === 'side' ? (
        <SideBySide a={paneA} b={shownB} labels={labels} />
      ) : props.mode === 'swipe' ? (
        <div
          className="overflow-hidden rounded-md border"
          data-testid="compare-swipe"
        >
          <ReactCompareSlider
            itemOne={
              <ReactCompareSliderImage src={paneA.url} alt={labels[0]} />
            }
            itemTwo={
              <ReactCompareSliderImage src={shownB.url} alt={labels[1]} />
            }
            style={{ aspectRatio: `${paneA.width} / ${paneA.height}` }}
          />
        </div>
      ) : (
        <div
          className="relative overflow-hidden rounded-md border bg-muted"
          style={{ aspectRatio: `${paneA.width} / ${paneA.height}` }}
          data-testid="compare-onion"
        >
          <img
            src={paneA.url}
            alt={labels[0]}
            className="absolute inset-0 size-full object-contain"
            draggable={false}
          />
          <img
            src={shownB.url}
            alt={labels[1]}
            className="absolute inset-0 size-full object-contain"
            style={{ opacity: props.opacity }}
            draggable={false}
          />
        </div>
      )}
    </div>
  );
};

export const CompareView = (props: CompareProps) =>
  props.check ? (
    <CompareWithCheck
      key={JSON.stringify([
        props.a,
        props.b,
        props.check.renderId,
        props.check.resultId,
      ])}
      {...props}
      check={props.check}
    />
  ) : (
    <ComparePanes {...props} />
  );
