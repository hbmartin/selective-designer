import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CropIcon, ImagePlusIcon } from 'lucide-react';
import { type PointerEvent, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/platform/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/platform/components/ui/dialog';
import { uploadFileToRoute } from '@/platform/components/upload/upload-file';

import { useCurrentScopeKey } from '@/modules/auth/client';
import type { DesignImageView } from '@/modules/design';
import { designQueries } from '@/modules/design/client';
import { prepareImageFiles } from '@/modules/design/presentation';
import { type DesignId, toObjectKey } from '@/modules/kernel/domain/ids';

import {
  type CropBox,
  cropToPng,
  isAcceptedPhoto,
  loadImage,
} from './image-tools';
import { ItemFormDialog } from './item-form-dialog';

type DragState = { startX: number; startY: number; box: CropBox | null };

/** Box selection over a source photo; produces a PNG crop for a new extract. */
const ExtractDialog = (props: {
  designId: DesignId;
  photo: DesignImageView | null;
  onClose: () => void;
}) => {
  const { t } = useTranslation(['moodboard']);
  const imageRef = useRef<HTMLImageElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [box, setBox] = useState<CropBox | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);

  const toImagePoint = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x:
        Math.min(Math.max(0, event.clientX - rect.left), rect.width) /
        rect.width,
      y:
        Math.min(Math.max(0, event.clientY - rect.top), rect.height) /
        rect.height,
    };
  };

  const useSelection = async () => {
    if (!props.photo || !box) return;
    try {
      const image = await loadImage(props.photo.workingUrl);
      const crop = await cropToPng(
        image,
        {
          x: box.x * image.naturalWidth,
          y: box.y * image.naturalHeight,
          width: box.width * image.naturalWidth,
          height: box.height * image.naturalHeight,
        },
        'extract.png'
      );
      setCropFile(crop);
    } catch {
      toast.error(t('moodboard:sourcePhotos.uploadError'));
    }
  };

  if (cropFile) {
    return (
      <ItemFormDialog
        designId={props.designId}
        initialFile={cropFile}
        initialKind="extract"
        open
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      />
    );
  }

  return (
    <Dialog
      open={Boolean(props.photo)}
      onOpenChange={(open: boolean) => !open && props.onClose()}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('moodboard:sourcePhotos.extractTitle')}</DialogTitle>
          <DialogDescription>
            {t('moodboard:sourcePhotos.extractHint')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {props.photo && (
            <div
              className="relative touch-none select-none"
              data-testid="extract-surface"
              onPointerDown={(event) => {
                const point = toImagePoint(event);
                event.currentTarget.setPointerCapture(event.pointerId);
                setDrag({ startX: point.x, startY: point.y, box: null });
              }}
              onPointerMove={(event) => {
                if (!drag) return;
                const point = toImagePoint(event);
                setBox({
                  x: Math.min(drag.startX, point.x),
                  y: Math.min(drag.startY, point.y),
                  width: Math.abs(point.x - drag.startX),
                  height: Math.abs(point.y - drag.startY),
                });
              }}
              onPointerUp={() => setDrag(null)}
            >
              <img
                ref={imageRef}
                src={props.photo.workingUrl}
                alt=""
                crossOrigin="anonymous"
                draggable={false}
                className="block w-full"
              />
              {box && (
                <div
                  className="pointer-events-none absolute border-2 border-primary bg-primary/10"
                  style={{
                    left: `${box.x * 100}%`,
                    top: `${box.y * 100}%`,
                    width: `${box.width * 100}%`,
                    height: `${box.height * 100}%`,
                  }}
                />
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            className="w-full"
            disabled={!box || box.width < 0.01 || box.height < 0.01}
            onClick={useSelection}
          >
            <CropIcon />
            {t('moodboard:sourcePhotos.extractButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const SourcePhotos = (props: { designId: DesignId }) => {
  const { t } = useTranslation(['moodboard']);
  const scopeKey = useCurrentScopeKey();
  const queryClient = useQueryClient();
  const inputId = useId();
  const [uploading, setUploading] = useState(false);
  const [extractFrom, setExtractFrom] = useState<DesignImageView | null>(null);
  const photos = useQuery(
    designQueries.sourcePhotos({ scopeKey, designId: props.designId })
  );
  const addPhoto = useMutation({
    ...designQueries.addSourcePhoto(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: designQueries.all() }),
  });

  const upload = async (file: File | undefined) => {
    if (!file || !isAcceptedPhoto(file)) return;
    setUploading(true);
    try {
      const prepared = await prepareImageFiles(file);
      const [originalKey, workingKey] = await Promise.all([
        uploadFileToRoute({ file: prepared.original, route: 'source_photo' }),
        uploadFileToRoute({ file: prepared.working, route: 'working_image' }),
      ]);
      const original = toObjectKey(originalKey);
      const working = toObjectKey(workingKey);
      if (original.isError() || working.isError()) throw new Error('bad key');
      await addPhoto.mutateAsync({
        designId: props.designId,
        photo: {
          originalKey: original.get(),
          original: prepared.originalSize,
          workingKey: working.get(),
          working: prepared.workingSize,
        },
      });
    } catch {
      toast.error(t('moodboard:sourcePhotos.uploadError'));
    } finally {
      setUploading(false);
    }
  };

  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby={`${inputId}-title`}
    >
      <div className="flex items-center justify-between">
        <h3 id={`${inputId}-title`} className="text-sm font-medium">
          {t('moodboard:sourcePhotos.title')}
        </h3>
        <Button
          size="xs"
          variant="ghost"
          loading={uploading}
          nativeButton={false}
          render={<label htmlFor={inputId} />}
        >
          <ImagePlusIcon />
          {t('moodboard:sourcePhotos.upload')}
        </Button>
        <input
          id={inputId}
          type="file"
          className="sr-only"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => upload(event.target.files?.[0])}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(photos.data ?? []).map((photo) => (
          <button
            key={photo.id}
            type="button"
            className="group relative aspect-[4/3] overflow-hidden rounded border"
            onClick={() => setExtractFrom(photo)}
            title={t('moodboard:sourcePhotos.extract')}
          >
            <img
              src={photo.workingUrl}
              alt=""
              className="size-full object-cover"
            />
            <span className="absolute inset-x-0 bottom-0 bg-foreground/60 px-1 text-[10px] text-background opacity-0 group-hover:opacity-100">
              {t('moodboard:sourcePhotos.extract')}
            </span>
          </button>
        ))}
      </div>
      {extractFrom && (
        <ExtractDialog
          designId={props.designId}
          photo={extractFrom}
          onClose={() => setExtractFrom(null)}
        />
      )}
    </section>
  );
};
