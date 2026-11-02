import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ImageIcon, UploadCloudIcon } from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  type ReactElement,
  useEffect,
  useId,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { cn } from '@/platform/lib/tailwind/utils';

import {
  Form,
  FormField,
  FormFieldLabel,
  useAppForm,
} from '@/platform/components/form';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/platform/components/ui/dialog';
import { uploadFileToRoute } from '@/platform/components/upload/upload-file';

import { toObjectKey } from '@/modules/kernel/domain/ids';

import {
  ACCEPTED_BASE_IMAGE_TYPES,
  imageFileFromClipboard,
  isAcceptedBaseImageFile,
  prepareImageFiles,
} from './image-files';
import { zFormFieldsDesignName } from './schema';
import { designQueries } from './wired-queries';

const fileNameWithoutExtension = (name: string) =>
  name.replace(/\.[^.]+$/u, '').slice(0, 120);

const uploadedKey = async (file: File, route: string) => {
  const key = toObjectKey(await uploadFileToRoute({ file, route }));
  if (key.isError()) throw key.getError();
  return key.get();
};

export const CreateDesignDialog = (props: { children: ReactElement }) => {
  const { t } = useTranslation(['design']);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const createDesign = useMutation({
    ...designQueries.create(),
    onSuccess: async (design) => {
      await queryClient.invalidateQueries({ queryKey: designQueries.all() });
      setOpen(false);
      await navigate({
        to: '/app/designs/$designId',
        params: { designId: design.id },
      });
    },
  });

  const form = useAppForm({
    defaultValues: { name: '' },
    validators: { onSubmit: zFormFieldsDesignName() },
    onSubmit: async ({ value }) => {
      if (!file) {
        toast.error(t('design:create.missingImage'));
        return;
      }
      try {
        const prepared = await prepareImageFiles(file);
        const [originalKey, workingKey] = await Promise.all([
          uploadedKey(prepared.original, 'base_image'),
          uploadedKey(prepared.working, 'working_image'),
        ]);
        await createDesign.mutateAsync({
          name: value.name,
          baseImage: {
            originalKey,
            original: prepared.originalSize,
            workingKey,
            working: prepared.workingSize,
          },
        });
      } catch {
        toast.error(t('design:create.errorMessage'));
      }
    },
  });

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl]
  );

  const selectFile = (next: File | undefined) => {
    if (!next || !isAcceptedBaseImageFile(next)) {
      if (next) toast.error(t('design:create.unsupportedType'));
      return;
    }
    setFile(next);
    setPreviewUrl(URL.createObjectURL(next));
    if (!form.getFieldValue('name')) {
      form.setFieldValue('name', fileNameWithoutExtension(next.name));
    }
  };

  const reset = () => {
    setFile(null);
    setPreviewUrl(null);
    form.reset({ name: '' });
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    selectFile(event.dataTransfer.files[0]);
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const pasted = imageFileFromClipboard(event);
    if (pasted) {
      event.preventDefault();
      selectFile(pasted);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen: boolean) => {
        setOpen(isOpen);
        if (!isOpen) reset();
      }}
    >
      <DialogTrigger render={props.children} />
      <DialogContent className="sm:max-w-lg" onPaste={onPaste}>
        <Form form={form} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('design:create.title')}</DialogTitle>
            <DialogDescription>
              {t('design:create.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <label
              htmlFor={inputId}
              data-testid="design-create-dropzone"
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={onDrop}
              className={cn(
                'flex aspect-video cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-md border border-dashed text-sm text-muted-foreground transition-colors hover:bg-accent/50',
                isDragOver && 'border-primary bg-accent/50'
              )}
            >
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt={t('design:create.previewAlt')}
                  className="size-full object-contain"
                />
              ) : (
                <>
                  <UploadCloudIcon className="size-6" />
                  <span>{t('design:create.dropzone')}</span>
                </>
              )}
            </label>
            <input
              id={inputId}
              type="file"
              className="sr-only"
              accept={ACCEPTED_BASE_IMAGE_TYPES.join(',')}
              onChange={(event) => selectFile(event.target.files?.[0])}
            />
            {file && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <ImageIcon className="size-3.5" />
                {file.name}
              </p>
            )}
            <FormField>
              <FormFieldLabel>{t('design:create.nameLabel')}</FormFieldLabel>
              <form.AppField name="name">
                {(field) => <field.FieldText type="text" autoFocus />}
              </form.AppField>
            </FormField>
          </DialogBody>
          <DialogFooter>
            <form.SubmitButton className="w-full" disabled={!file}>
              {t('design:create.submitButton')}
            </form.SubmitButton>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
