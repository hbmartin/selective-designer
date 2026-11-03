import { useQuery } from '@tanstack/react-query';
import {
  BrushIcon,
  LassoIcon,
  MousePointer2Icon,
  MousePointerClickIcon,
  Redo2Icon,
  Trash2Icon,
  Undo2Icon,
} from 'lucide-react';
import { lazy, type ReactNode, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import { type MaskShape, rasterizeMask } from '@/platform/components/canvas';
import { Button } from '@/platform/components/ui/button';
import { Input } from '@/platform/components/ui/input';
import { Skeleton } from '@/platform/components/ui/skeleton';
import { Textarea } from '@/platform/components/ui/textarea';

import { useCurrentScopeKey } from '@/modules/auth/client';
import type { ImageId } from '@/modules/kernel/domain/ids';

import {
  addEdit,
  createDraftStore,
  type DraftStore,
  newEditId,
  removeEdit,
  setPrompt,
  updateEdit,
} from './draft-store';
import {
  type EditorItem,
  type EditorRegion,
  type EditorTool,
  type FractionalPoint,
  ITEM_DRAG_TYPE,
} from './editor-types';
import { RenderDialog } from './render-dialog';
import { useDraftAutosave } from './use-draft-autosave';
import { renderingQueries } from '../wired-queries';
import type { RenderSourceView } from '../../application/use-cases/renders';
import {
  type Edit,
  type FractionalBox,
  PROMPT_MAX_LENGTH,
} from '../../domain/edit-set';
import type { Draft } from '../../domain/render';

const EditorCanvas = lazy(async () => ({
  default: (await import('./editor-canvas')).EditorCanvas,
}));

const nativeSelectClass =
  'h-8 w-full rounded-md border border-input bg-background px-2 text-sm';
const DEFAULT_PLACEMENT_WIDTH = 0.2;

export type RenderingEditorProps = {
  imageId: ImageId;
  items: readonly EditorItem[];
  regions: readonly EditorRegion[];
  /** Create a region by clicking an object (segmentation). */
  onSegmentAt: (point: FractionalPoint) => Promise<void>;
  /** Save a drawn region (mask PNG at the source's native size). */
  onCreateRegion: (input: {
    mask: Blob;
    box: FractionalBox;
    source: 'lasso' | 'brush';
  }) => Promise<void>;
  onSubmitted: (renderIds: string[]) => void;
  /** Slot above the canvas (e.g. a back link). */
  header?: ReactNode;
};

/** Placement box centred on `point`, sized from the item's aspect ratio. */
const placementBox = (
  point: FractionalPoint,
  item: EditorItem,
  source: { width: number; height: number }
): FractionalBox => {
  const aspect = item.imageSize
    ? item.imageSize.width / item.imageSize.height
    : 1;
  const width = DEFAULT_PLACEMENT_WIDTH;
  const height = Math.min(1, (width * source.width) / aspect / source.height);
  return {
    x: Math.min(1 - width, Math.max(0, point.x - width / 2)),
    y: Math.min(1 - height, Math.max(0, point.y - height / 2)),
    width,
    height,
  };
};

const EditDescription = (props: {
  edit: Edit;
  items: ReadonlyMap<string, EditorItem>;
  regions: ReadonlyMap<string, EditorRegion>;
}) => {
  const { t } = useTranslation(['rendering']);
  const item = (id: string) =>
    props.items.get(id)?.name ?? t('rendering:edits.unknownItem');
  const region = (id: string) =>
    props.regions.get(id)?.label ?? t('rendering:edits.unknownRegion');
  const { edit } = props;
  switch (edit.kind) {
    case 'placement':
      return <>{t('rendering:edits.placement', { item: item(edit.itemId) })}</>;
    case 'replacement':
      return (
        <>
          {t('rendering:edits.replacement', {
            region: region(edit.regionId),
            item: item(edit.itemId),
          })}
        </>
      );
    case 'removal':
      return (
        <>{t('rendering:edits.removal', { region: region(edit.regionId) })}</>
      );
    case 'material':
      return (
        <>
          {t('rendering:edits.material', {
            region: region(edit.regionId),
            material: edit.swatchItemId ? item(edit.swatchItemId) : edit.text,
          })}
        </>
      );
  }
};

const RegionActions = (props: {
  region: EditorRegion;
  items: readonly EditorItem[];
  onAdd: (edit: Edit) => void;
}) => {
  const { t } = useTranslation(['rendering']);
  const [mode, setMode] = useState<'replace' | 'material' | null>(null);
  const [itemId, setItemId] = useState('');
  const [text, setText] = useState('');
  const placeable = props.items.filter(
    (item) => item.kind !== 'swatch' && item.ready
  );
  const swatches = props.items.filter((item) => item.kind === 'swatch');
  const reset = () => {
    setMode(null);
    setItemId('');
    setText('');
  };
  const base = { id: newEditId(), regionId: props.region.id };
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card p-2">
      <div className="flex flex-wrap gap-1">
        <Button
          size="xs"
          variant="secondary"
          onClick={() => props.onAdd({ kind: 'removal', ...base, note: '' })}
        >
          {t('rendering:regions.remove')}
        </Button>
        <Button
          size="xs"
          variant={mode === 'replace' ? 'secondary' : 'ghost'}
          onClick={() => setMode('replace')}
          disabled={placeable.length === 0}
        >
          {t('rendering:regions.replace')}
        </Button>
        <Button
          size="xs"
          variant={mode === 'material' ? 'secondary' : 'ghost'}
          onClick={() => setMode('material')}
        >
          {t('rendering:regions.material')}
        </Button>
      </div>
      {mode && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === 'replace' && itemId) {
              props.onAdd({ kind: 'replacement', ...base, itemId, note: '' });
              reset();
            } else if (mode === 'material' && (itemId || text.trim())) {
              props.onAdd({
                kind: 'material',
                ...base,
                swatchItemId: itemId || null,
                text: text.trim(),
              });
              reset();
            }
          }}
        >
          <select
            className={nativeSelectClass}
            value={itemId}
            onChange={(event) => setItemId(event.target.value)}
            aria-label={
              mode === 'replace'
                ? t('rendering:regions.chooseItem')
                : t('rendering:regions.chooseSwatch')
            }
          >
            <option value="">
              {mode === 'replace'
                ? t('rendering:regions.chooseItem')
                : t('rendering:regions.chooseSwatch')}
            </option>
            {(mode === 'replace' ? placeable : swatches).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {mode === 'material' && (
            <Input
              size="sm"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t('rendering:regions.materialPlaceholder')}
              aria-label={t('rendering:regions.materialText')}
            />
          )}
          <Button size="xs" type="submit">
            {t('rendering:regions.add')}
          </Button>
        </form>
      )}
    </div>
  );
};

const ToolButton = (props: {
  tool: EditorTool;
  active: EditorTool;
  icon: ReactNode;
  label: string;
  onSelect: (tool: EditorTool) => void;
}) => (
  <Button
    size="sm"
    variant={props.active === props.tool ? 'secondary' : 'ghost'}
    aria-pressed={props.active === props.tool}
    onClick={() => props.onSelect(props.tool)}
  >
    {props.icon}
    {props.label}
  </Button>
);

const EditorBody = (
  props: RenderingEditorProps & { source: RenderSourceView; store: DraftStore }
) => {
  const { t } = useTranslation(['rendering']);
  const { store, source } = props;
  const editSet = useStore(store, (state) => state.editSet);
  const selectedEditId = useStore(store, (state) => state.selectedEditId);
  const canUndo = useStore(store, (state) => state.past.length > 0);
  const canRedo = useStore(store, (state) => state.future.length > 0);
  const autosave = useDraftAutosave(store, props.imageId);
  const [tool, setTool] = useState<EditorTool>('select');
  const [brushWidth, setBrushWidth] = useState(0.03);
  const [strokes, setStrokes] = useState<MaskShape[]>([]);
  const [activeRegionId, setActiveRegionId] = useState<string | null>(null);
  const [hoverRegionId, setHoverRegionId] = useState<string | null>(null);
  const [renderOpen, setRenderOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const items = useMemo(
    () => new Map(props.items.map((item) => [item.id, item])),
    [props.items]
  );
  const regions = useMemo(
    () => new Map(props.regions.map((region) => [region.id, region])),
    [props.regions]
  );
  const apply = store.getState().apply;
  const size = { width: source.width, height: source.height };

  const place = (itemId: string, point: FractionalPoint) => {
    const item = items.get(itemId);
    if (!item || item.kind === 'swatch' || !item.ready) return;
    const id = newEditId();
    apply(
      addEdit({
        kind: 'placement',
        id,
        itemId,
        box: placementBox(point, item, size),
        rotationDeg: 0,
        note: '',
      })
    );
    store.getState().select(id);
    setTool('select');
  };

  const saveRegion = async (shapes: MaskShape[], kind: 'lasso' | 'brush') => {
    const raster = await rasterizeMask(shapes, size);
    if (!raster) return;
    setBusy(true);
    try {
      await props.onCreateRegion({
        mask: raster.blob,
        box: raster.box,
        source: kind,
      });
      if (kind === 'brush') setStrokes([]);
    } finally {
      setBusy(false);
    }
  };

  const status = autosave.isSaving
    ? t('rendering:editor.saving')
    : autosave.isDirty
      ? t('rendering:editor.unsaved')
      : t('rendering:editor.saved');
  const hint = t(
    `rendering:tools.hint${tool[0]?.toUpperCase()}${tool.slice(1)}` as never
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-2">
        {props.header}
        <div
          className="flex flex-wrap items-center gap-1"
          role="toolbar"
          aria-label={t('rendering:tools.title')}
        >
          <ToolButton
            tool="select"
            active={tool}
            onSelect={setTool}
            icon={<MousePointer2Icon />}
            label={t('rendering:tools.select')}
          />
          <ToolButton
            tool="click"
            active={tool}
            onSelect={setTool}
            icon={<MousePointerClickIcon />}
            label={t('rendering:tools.click')}
          />
          <ToolButton
            tool="lasso"
            active={tool}
            onSelect={setTool}
            icon={<LassoIcon />}
            label={t('rendering:tools.lasso')}
          />
          <ToolButton
            tool="brush"
            active={tool}
            onSelect={setTool}
            icon={<BrushIcon />}
            label={t('rendering:tools.brush')}
          />
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('rendering:editor.undo')}
            disabled={!canUndo}
            onClick={() => store.getState().undo()}
          >
            <Undo2Icon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('rendering:editor.redo')}
            disabled={!canRedo}
            onClick={() => store.getState().redo()}
          >
            <Redo2Icon />
          </Button>
          <span
            className="ml-auto text-xs text-muted-foreground"
            aria-live="polite"
            data-testid="draft-status"
          >
            {status}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
        {tool === 'brush' && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-2">
              {t('rendering:tools.brushSize')}
              <input
                type="range"
                min={0.005}
                max={0.1}
                step={0.005}
                value={brushWidth}
                onChange={(event) => setBrushWidth(Number(event.target.value))}
              />
            </label>
            <Button
              size="xs"
              disabled={strokes.length === 0}
              loading={busy}
              onClick={() => saveRegion(strokes, 'brush')}
            >
              {t('rendering:tools.saveBrush')}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={strokes.length === 0}
              onClick={() => setStrokes([])}
            >
              {t('rendering:tools.clearBrush')}
            </Button>
          </div>
        )}
        <Suspense
          fallback={
            <Skeleton
              className="w-full"
              style={{ aspectRatio: `${source.width} / ${source.height}` }}
            />
          }
        >
          <EditorCanvas
            source={source}
            editSet={editSet}
            items={items}
            regions={regions}
            selectedEditId={selectedEditId}
            highlightRegionId={hoverRegionId ?? activeRegionId}
            tool={tool}
            brushWidth={brushWidth}
            brushStrokes={strokes}
            labels={{
              canvas: t('rendering:editor.canvasLabel'),
              loading: t('rendering:editor.loadingImage'),
              failed: t('rendering:editor.imageFailed'),
            }}
            onSelectEdit={(id) => store.getState().select(id)}
            onPlacementChange={(id, box, rotationDeg) =>
              apply(
                updateEdit(id, (edit) =>
                  edit.kind === 'placement'
                    ? { ...edit, box, rotationDeg }
                    : edit
                )
              )
            }
            onDropItem={place}
            onClickPoint={(point) => {
              setBusy(true);
              props
                .onSegmentAt(point)
                .finally(() => setBusy(false))
                .catch(() => undefined);
            }}
            onLasso={(points) =>
              saveRegion([{ kind: 'polygon', points }], 'lasso')
            }
            onBrushStroke={(stroke) =>
              setStrokes((current) => [...current, stroke])
            }
          />
        </Suspense>
      </div>

      <aside
        className="flex flex-col gap-5"
        aria-label={t('rendering:edits.title')}
      >
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">{t('rendering:items.title')}</h2>
          {props.items.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('rendering:items.empty')}
            </p>
          ) : (
            <ul className="grid grid-cols-4 gap-2">
              {props.items.map((item) => {
                const placeable = item.kind !== 'swatch' && item.ready;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex w-full flex-col items-center gap-1 rounded-md border bg-card p-1 text-[10px] disabled:opacity-50"
                      draggable={placeable}
                      disabled={!placeable}
                      title={
                        item.kind === 'swatch'
                          ? t('rendering:items.swatchHint')
                          : item.ready
                            ? t('rendering:items.place', { name: item.name })
                            : t('rendering:items.notReady')
                      }
                      aria-label={t('rendering:items.place', {
                        name: item.name,
                      })}
                      data-testid="editor-item"
                      onDragStart={(event) => {
                        event.dataTransfer.setData(ITEM_DRAG_TYPE, item.id);
                        event.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={() => place(item.id, { x: 0.5, y: 0.5 })}
                    >
                      <img
                        src={item.imageUrl}
                        alt=""
                        draggable={false}
                        className="aspect-square w-full rounded bg-transparency-grid object-contain"
                      />
                      <span className="w-full truncate">{item.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">
            {t('rendering:regions.title')}{' '}
            <span className="text-muted-foreground">
              ({props.regions.length})
            </span>
          </h2>
          {props.regions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('rendering:regions.empty')}
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1">
              {props.regions.map((region) => (
                <li key={region.id}>
                  <Button
                    size="xs"
                    variant={
                      activeRegionId === region.id ? 'secondary' : 'ghost'
                    }
                    aria-pressed={activeRegionId === region.id}
                    data-testid="editor-region"
                    onMouseEnter={() => setHoverRegionId(region.id)}
                    onMouseLeave={() => setHoverRegionId(null)}
                    onClick={() =>
                      setActiveRegionId((id) =>
                        id === region.id ? null : region.id
                      )
                    }
                  >
                    {region.label}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {activeRegionId && regions.get(activeRegionId) && (
            <RegionActions
              key={activeRegionId}
              region={regions.get(activeRegionId) as EditorRegion}
              items={props.items}
              onAdd={(edit) => {
                apply(addEdit(edit));
                setActiveRegionId(null);
              }}
            />
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">{t('rendering:edits.title')}</h2>
          {editSet.edits.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('rendering:edits.empty')}
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {editSet.edits.map((edit) => (
                <li
                  key={edit.id}
                  data-testid="editor-edit"
                  data-kind={edit.kind}
                  className={`flex flex-col gap-1 rounded-md border p-2 text-sm ${selectedEditId === edit.id ? 'border-primary' : ''}`}
                  onClick={() => store.getState().select(edit.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      <EditDescription
                        edit={edit}
                        items={items}
                        regions={regions}
                      />
                    </span>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t('rendering:edits.delete')}
                      onClick={(event) => {
                        event.stopPropagation();
                        apply(removeEdit(edit.id));
                      }}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                  {edit.kind !== 'material' && (
                    <Input
                      size="sm"
                      value={edit.note}
                      placeholder={t('rendering:edits.notePlaceholder')}
                      aria-label={t('rendering:edits.note')}
                      onChange={(event) =>
                        apply(
                          updateEdit(edit.id, (current) =>
                            current.kind === 'material'
                              ? current
                              : { ...current, note: event.target.value }
                          )
                        )
                      }
                    />
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('rendering:prompt.label')}</span>
          <Textarea
            value={editSet.prompt}
            rows={3}
            placeholder={t('rendering:prompt.placeholder')}
            onChange={(event) =>
              apply(setPrompt(event.target.value.slice(0, PROMPT_MAX_LENGTH)))
            }
          />
        </label>

        <div className="flex flex-col gap-1">
          <Button
            disabled={editSet.edits.length === 0}
            onClick={() => setRenderOpen(true)}
            data-testid="open-render"
          >
            {t('rendering:render.open')}
          </Button>
          {editSet.edits.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t('rendering:render.needsEdit')}
            </p>
          )}
        </div>
        <RenderDialog
          open={renderOpen}
          onOpenChange={setRenderOpen}
          imageId={props.imageId}
          editSet={editSet}
          items={items}
          flush={autosave.flush}
          onSubmitted={props.onSubmitted}
        />
      </aside>
    </div>
  );
};

const EditorWithDraft = (
  props: RenderingEditorProps & { source: RenderSourceView; draft: Draft }
) => {
  const [store] = useState(() =>
    createDraftStore({
      editSet: props.draft.editSet,
      revision: props.draft.revision,
    })
  );
  return <EditorBody {...props} store={store} />;
};

/**
 * The edit surface for one render source: places mood-board items, turns
 * regions into edits, autosaves the draft and submits renders.
 */
export const RenderingEditor = (props: RenderingEditorProps) => {
  const scopeKey = useCurrentScopeKey();
  const source = useQuery(
    renderingQueries.source({ scopeKey, imageId: props.imageId })
  );
  const draft = useQuery({
    ...renderingQueries.draft({ scopeKey, imageId: props.imageId }),
    // The local store owns the draft after the first load.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  if (!source.data || !draft.data) {
    return <Skeleton className="aspect-video w-full" />;
  }
  return (
    <EditorWithDraft
      key={props.imageId}
      {...props}
      source={source.data}
      draft={draft.data}
    />
  );
};
