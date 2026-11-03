import type Konva from 'konva';
import { type DragEvent, useEffect, useRef, useState } from 'react';
import {
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
  Transformer,
} from 'react-konva';

import {
  type MaskShape,
  useCanvasColors,
  useContainerWidth,
  useHtmlImage,
} from '@/platform/components/canvas';

import {
  type EditorItem,
  type EditorRegion,
  type EditorTool,
  type FractionalPoint,
  ITEM_DRAG_TYPE,
} from './editor-types';
import type { Edit, EditSet, FractionalBox } from '../../domain/edit-set';

export type EditorCanvasProps = {
  source: { url: string; width: number; height: number };
  editSet: EditSet;
  items: ReadonlyMap<string, EditorItem>;
  regions: ReadonlyMap<string, EditorRegion>;
  selectedEditId: string | null;
  highlightRegionId: string | null;
  tool: EditorTool;
  brushWidth: number;
  brushStrokes: readonly MaskShape[];
  labels: { canvas: string; loading: string; failed: string };
  onSelectEdit: (editId: string | null) => void;
  onPlacementChange: (
    editId: string,
    box: FractionalBox,
    rotationDeg: number
  ) => void;
  onDropItem: (itemId: string, point: FractionalPoint) => void;
  onClickPoint: (point: FractionalPoint) => void;
  onLasso: (points: number[]) => void;
  onBrushStroke: (stroke: MaskShape) => void;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

type Placement = Extract<Edit, { kind: 'placement' }>;

const PlacementNode = (props: {
  edit: Placement;
  item: EditorItem | undefined;
  size: { width: number; height: number };
  draggable: boolean;
  onSelect: () => void;
  onChange: (box: FractionalBox, rotationDeg: number) => void;
  register: (id: string, node: Konva.Image | null) => void;
}) => {
  const image = useHtmlImage(props.item?.imageUrl ?? null);
  const { edit, size } = props;
  const width = edit.box.width * size.width;
  const height = edit.box.height * size.height;
  const commit = (node: Konva.Node) => {
    const nextWidth = Math.max(4, node.width() * node.scaleX());
    const nextHeight = Math.max(4, node.height() * node.scaleY());
    node.scaleX(1);
    node.scaleY(1);
    const x = clamp01((node.x() - nextWidth / 2) / size.width);
    const y = clamp01((node.y() - nextHeight / 2) / size.height);
    props.onChange(
      {
        x,
        y,
        width: Math.min(1, nextWidth / size.width),
        height: Math.min(1, nextHeight / size.height),
      },
      Math.round(node.rotation())
    );
  };
  if (image.status !== 'loaded') return null;
  return (
    <KonvaImage
      ref={(node) => props.register(edit.id, node)}
      image={image.image}
      x={(edit.box.x + edit.box.width / 2) * size.width}
      y={(edit.box.y + edit.box.height / 2) * size.height}
      width={width}
      height={height}
      offsetX={width / 2}
      offsetY={height / 2}
      rotation={edit.rotationDeg}
      draggable={props.draggable}
      onMouseDown={props.onSelect}
      onTap={props.onSelect}
      onDragEnd={(event) => commit(event.target)}
      onTransformEnd={(event) => commit(event.target)}
    />
  );
};

/** Konva editor surface. Client-only: load it lazily. */
export const EditorCanvas = (props: EditorCanvasProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);
  const colors = useCanvasColors();
  const sourceImage = useHtmlImage(props.source.url);
  const transformerRef = useRef<Konva.Transformer>(null);
  const nodes = useRef(new Map<string, Konva.Image>());
  const [drawing, setDrawing] = useState<number[] | null>(null);

  const size = { width: props.source.width, height: props.source.height };
  const scale = width > 0 ? width / size.width : 0;
  const placementsMovable = props.tool === 'select';

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node =
      props.selectedEditId && placementsMovable
        ? nodes.current.get(props.selectedEditId)
        : undefined;
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [props.selectedEditId, placementsMovable, props.editSet]);

  const pointer = (stage: Konva.Stage | null): FractionalPoint | null => {
    const position = stage?.getPointerPosition();
    if (!position || scale === 0) return null;
    return {
      x: clamp01(position.x / scale / size.width),
      y: clamp01(position.y / scale / size.height),
    };
  };

  const onStageDown = (
    event: Konva.KonvaEventObject<MouseEvent | TouchEvent>
  ) => {
    const stage = event.target.getStage();
    const point = pointer(stage);
    if (!point) return;
    if (props.tool === 'select') {
      if (event.target === stage || event.target.name() === 'source')
        props.onSelectEdit(null);
      return;
    }
    if (props.tool === 'click') {
      props.onClickPoint(point);
      return;
    }
    setDrawing([point.x, point.y]);
  };
  const onStageMove = (
    event: Konva.KonvaEventObject<MouseEvent | TouchEvent>
  ) => {
    if (!drawing) return;
    const point = pointer(event.target.getStage());
    if (point) setDrawing([...drawing, point.x, point.y]);
  };
  const onStageUp = () => {
    if (!drawing) return;
    if (props.tool === 'lasso' && drawing.length >= 6) props.onLasso(drawing);
    if (props.tool === 'brush' && drawing.length >= 2) {
      props.onBrushStroke({
        kind: 'stroke',
        points: drawing,
        widthFraction: props.brushWidth,
      });
    }
    setDrawing(null);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const itemId = event.dataTransfer.getData(ITEM_DRAG_TYPE);
    if (!itemId) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    props.onDropItem(itemId, {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    });
  };

  const toPixels = (points: readonly number[]) =>
    points.map(
      (value, index) => value * (index % 2 === 0 ? size.width : size.height)
    );

  const regionMarks = props.editSet.edits.flatMap((edit) =>
    edit.kind === 'placement'
      ? []
      : [{ edit, region: props.regions.get(edit.regionId) }]
  );
  const highlighted = props.highlightRegionId
    ? props.regions.get(props.highlightRegionId)
    : undefined;

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded-md border bg-muted"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
      role="application"
      aria-label={props.labels.canvas}
      data-testid="editor-canvas"
      data-tool={props.tool}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(ITEM_DRAG_TYPE))
          event.preventDefault();
      }}
      onDrop={onDrop}
    >
      {sourceImage.status !== 'loaded' && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {sourceImage.status === 'failed'
            ? props.labels.failed
            : props.labels.loading}
        </p>
      )}
      {scale > 0 && sourceImage.status === 'loaded' && (
        <Stage
          width={width}
          height={Math.round(size.height * scale)}
          scaleX={scale}
          scaleY={scale}
          onMouseDown={onStageDown}
          onTouchStart={onStageDown}
          onMouseMove={onStageMove}
          onTouchMove={onStageMove}
          onMouseUp={onStageUp}
          onTouchEnd={onStageUp}
          className={props.tool === 'select' ? undefined : 'cursor-crosshair'}
        >
          <Layer>
            <KonvaImage
              name="source"
              image={sourceImage.image}
              width={size.width}
              height={size.height}
            />
          </Layer>
          <Layer listening={false}>
            {regionMarks.map(({ edit, region }) =>
              region ? (
                <Group key={edit.id}>
                  <Rect
                    x={region.box.x * size.width}
                    y={region.box.y * size.height}
                    width={region.box.width * size.width}
                    height={region.box.height * size.height}
                    stroke={
                      edit.kind === 'removal' ? colors.danger : colors.highlight
                    }
                    strokeWidth={2 / scale}
                    dash={[8 / scale, 4 / scale]}
                  />
                  <Text
                    x={region.box.x * size.width + 4 / scale}
                    y={region.box.y * size.height + 4 / scale}
                    text={region.label}
                    fontSize={13 / scale}
                    fill={colors.label}
                    shadowColor="black"
                    shadowBlur={4 / scale}
                  />
                </Group>
              ) : null
            )}
            {highlighted && (
              <Rect
                x={highlighted.box.x * size.width}
                y={highlighted.box.y * size.height}
                width={highlighted.box.width * size.width}
                height={highlighted.box.height * size.height}
                stroke={colors.accent}
                strokeWidth={3 / scale}
              />
            )}
            {props.brushStrokes.map((stroke, index) => (
              <Line
                // oxlint-disable-next-line react/no-array-index-key -- strokes are append-only.
                key={index}
                points={toPixels(stroke.points)}
                stroke={colors.accent}
                opacity={0.5}
                strokeWidth={
                  stroke.kind === 'stroke'
                    ? stroke.widthFraction * size.width
                    : 1
                }
                lineCap="round"
                lineJoin="round"
              />
            ))}
            {drawing && (
              <Line
                points={toPixels(drawing)}
                stroke={colors.accent}
                opacity={props.tool === 'brush' ? 0.5 : 1}
                strokeWidth={
                  props.tool === 'brush'
                    ? props.brushWidth * size.width
                    : 2 / scale
                }
                closed={props.tool === 'lasso'}
                fill={props.tool === 'lasso' ? colors.accent : undefined}
                fillEnabled={props.tool === 'lasso'}
                lineCap="round"
                lineJoin="round"
              />
            )}
          </Layer>
          <Layer listening={props.tool === 'select'}>
            {props.editSet.edits.map((edit) =>
              edit.kind === 'placement' ? (
                <PlacementNode
                  key={edit.id}
                  edit={edit}
                  item={props.items.get(edit.itemId)}
                  size={size}
                  draggable={placementsMovable}
                  onSelect={() => props.onSelectEdit(edit.id)}
                  onChange={(box, rotationDeg) =>
                    props.onPlacementChange(edit.id, box, rotationDeg)
                  }
                  register={(id, node) => {
                    if (node) nodes.current.set(id, node);
                    else nodes.current.delete(id);
                  }}
                />
              ) : null
            )}
            <Transformer
              ref={transformerRef}
              rotateEnabled
              keepRatio
              borderStroke={colors.accent}
              anchorStroke={colors.accent}
              anchorSize={9}
              rotationSnaps={[0, 90, 180, 270]}
            />
          </Layer>
        </Stage>
      )}
    </div>
  );
};
