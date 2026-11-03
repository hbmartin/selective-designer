import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EraserIcon, PaintbrushIcon } from 'lucide-react';
import {
  type PointerEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/platform/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/platform/components/ui/dialog';
import { uploadFileToRoute } from '@/platform/components/upload/upload-file';

import { toObjectKey } from '@/modules/kernel/domain/ids';

import { canvasToPngFile, loadImage } from './image-tools';
import { moodboardQueries } from './wired-queries';
import type { ItemView } from '../application/use-cases/item-view';

const MAX_EDGE = 2048;
type Mode = 'erase' | 'restore';

type Editor = {
  photo: HTMLImageElement;
  mask: HTMLCanvasElement;
  width: number;
  height: number;
};

/**
 * Erase/restore brush over an item's cut-out. The mask lives in an offscreen
 * canvas (alpha = kept pixels); saving uploads a new cut-out and mask, which
 * the server stores as a new item version.
 */
export const CutoutEditorDialog = (props: {
  item: ItemView;
  children: ReactElement;
}) => {
  const { t } = useTranslation(['moodboard']);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('erase');
  const [brush, setBrush] = useState(40);
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const drawingRef = useRef(false);

  const correct = useMutation({
    ...moodboardQueries.correctCutout(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: moodboardQueries.all() }),
  });

  const redraw = useCallback(() => {
    const editor = editorRef.current;
    const canvas = canvasRef.current;
    if (!editor || !canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, editor.width, editor.height);
    context.globalAlpha = 0.25;
    context.drawImage(editor.photo, 0, 0, editor.width, editor.height);
    context.globalAlpha = 1;
    const layer = document.createElement('canvas');
    layer.width = editor.width;
    layer.height = editor.height;
    const layerContext = layer.getContext('2d');
    if (!layerContext) return;
    layerContext.drawImage(editor.photo, 0, 0, editor.width, editor.height);
    layerContext.globalCompositeOperation = 'destination-in';
    layerContext.drawImage(editor.mask, 0, 0);
    context.drawImage(layer, 0, 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const photo = await loadImage(props.item.photoUrl);
      const scale = Math.min(
        1,
        MAX_EDGE / Math.max(photo.naturalWidth, photo.naturalHeight)
      );
      const width = Math.round(photo.naturalWidth * scale);
      const height = Math.round(photo.naturalHeight * scale);
      const mask = document.createElement('canvas');
      mask.width = width;
      mask.height = height;
      const maskContext = mask.getContext('2d');
      if (!maskContext) return;
      if (props.item.cutoutUrl) {
        const cutout = await loadImage(props.item.cutoutUrl);
        maskContext.drawImage(cutout, 0, 0, width, height);
      } else {
        maskContext.fillStyle = 'white';
        maskContext.fillRect(0, 0, width, height);
      }
      if (cancelled || !canvasRef.current) return;
      canvasRef.current.width = width;
      canvasRef.current.height = height;
      editorRef.current = { photo, mask, width, height };
      redraw();
    })().catch(() => toast.error(t('moodboard:cutout.error')));
    return () => {
      cancelled = true;
    };
  }, [open, props.item.photoUrl, props.item.cutoutUrl, redraw, t]);

  const paint = (event: PointerEvent<HTMLCanvasElement>) => {
    const editor = editorRef.current;
    const canvas = canvasRef.current;
    if (!editor || !canvas || !drawingRef.current) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * editor.width;
    const y = ((event.clientY - rect.top) / rect.height) * editor.height;
    const radius = (brush / rect.width) * editor.width;
    const context = editor.mask.getContext('2d');
    if (!context) return;
    context.globalCompositeOperation =
      mode === 'erase' ? 'destination-out' : 'source-over';
    context.fillStyle = 'white';
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    redraw();
  };

  const save = async () => {
    const editor = editorRef.current;
    if (!editor) return;
    setSaving(true);
    try {
      const cutout = document.createElement('canvas');
      cutout.width = editor.width;
      cutout.height = editor.height;
      const context = cutout.getContext('2d');
      if (!context) throw new Error('no context');
      context.drawImage(editor.photo, 0, 0, editor.width, editor.height);
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(editor.mask, 0, 0);
      const [cutoutFile, maskFile] = await Promise.all([
        canvasToPngFile(cutout, 'cutout.png'),
        canvasToPngFile(editor.mask, 'mask.png'),
      ]);
      const [cutoutKey, maskKey] = await Promise.all([
        uploadFileToRoute({ file: cutoutFile, route: 'item_cutout' }),
        uploadFileToRoute({ file: maskFile, route: 'item_mask' }),
      ]);
      const parsedCutout = toObjectKey(cutoutKey);
      const parsedMask = toObjectKey(maskKey);
      if (parsedCutout.isError() || parsedMask.isError())
        throw new Error('bad key');
      await correct.mutateAsync({
        itemId: props.item.id,
        cutoutKey: parsedCutout.get(),
        maskKey: parsedMask.get(),
      });
      toast.success(t('moodboard:cutout.saved'));
      setOpen(false);
    } catch {
      toast.error(t('moodboard:cutout.error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen: boolean) => setOpen(isOpen)}>
      <DialogTrigger render={props.children} />
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('moodboard:cutout.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={mode === 'erase' ? 'secondary' : 'ghost'}
              aria-pressed={mode === 'erase'}
              onClick={() => setMode('erase')}
            >
              <EraserIcon />
              {t('moodboard:cutout.erase')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'restore' ? 'secondary' : 'ghost'}
              aria-pressed={mode === 'restore'}
              onClick={() => setMode('restore')}
            >
              <PaintbrushIcon />
              {t('moodboard:cutout.restore')}
            </Button>
            <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              {t('moodboard:cutout.brushSize')}
              <input
                type="range"
                min={5}
                max={120}
                value={brush}
                onChange={(event) => setBrush(Number(event.target.value))}
              />
            </label>
          </div>
          <div className="overflow-hidden rounded-md border bg-transparency-grid">
            <canvas
              ref={canvasRef}
              data-testid="cutout-editor-canvas"
              className="block h-auto w-full cursor-crosshair touch-none"
              onPointerDown={(event) => {
                drawingRef.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                paint(event);
              }}
              onPointerMove={paint}
              onPointerUp={() => {
                drawingRef.current = false;
              }}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button className="w-full" loading={saving} onClick={save}>
            {t('moodboard:cutout.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
