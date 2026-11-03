import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UploadCloudIcon } from 'lucide-react';
import {
  type ClipboardEvent,
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
import { Button } from '@/platform/components/ui/button';
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

import { useCurrentScopeKey } from '@/modules/auth/client';
import { type DesignId, toObjectKey } from '@/modules/kernel/domain/ids';

import {
  ACCEPTED_PHOTO_TYPES,
  fileNameWithoutExtension,
  isAcceptedPhoto,
  photoFromClipboard,
  readImageSize,
} from './image-tools';
import { zFormFieldsItem } from './schema';
import { moodboardQueries } from './wired-queries';
import type { ItemView } from '../application/use-cases/item-view';
import type { ItemKind } from '../domain/item';

type Props = {
  designId: DesignId;
  /** Trigger element; omit when the dialog is controlled with `open`. */
  children?: ReactElement;
  /** Edit an existing item instead of creating one. */
  item?: ItemView;
  /** Pre-filled photo, e.g. a crop extracted from a source photo. */
  initialFile?: File;
  initialKind?: ItemKind;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const ItemFormDialog = (props: Props) => {
  const { t } = useTranslation(['moodboard']);
  const queryClient = useQueryClient();
  const scopeKey = useCurrentScopeKey();
  const inputId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = props.open ?? uncontrolledOpen;
  const setOpen = props.onOpenChange ?? setUncontrolledOpen;
  const [kind, setKind] = useState<ItemKind>(
    props.item?.kind ?? props.initialKind ?? 'product'
  );
  const [file, setFile] = useState<File | null>(props.initialFile ?? null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const categories = useQuery({
    ...moodboardQueries.categories({ scopeKey }),
    enabled: open,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: moodboardQueries.all() });
  const createItem = useMutation({
    ...moodboardQueries.createItem(),
    onSuccess: invalidate,
  });
  const updateItem = useMutation({
    ...moodboardQueries.updateItem(),
    onSuccess: invalidate,
  });

  const form = useAppForm({
    defaultValues: {
      name: String(
        props.item?.name ??
          (props.initialFile
            ? fileNameWithoutExtension(props.initialFile.name)
            : '')
      ),
      category: String(props.item?.category ?? ''),
      vendor: props.item?.vendor ?? '',
      productUrl: props.item?.productUrl ?? '',
    },
    validators: { onSubmit: zFormFieldsItem() },
    onSubmit: async ({ value }) => {
      try {
        if (props.item) {
          await updateItem.mutateAsync({
            itemId: props.item.id,
            name: value.name,
            category: value.category,
            vendor: value.vendor || null,
            productUrl: value.productUrl || null,
          });
        } else {
          if (!file) {
            toast.error(t('moodboard:form.missingPhoto'));
            return;
          }
          const size = await readImageSize(file);
          const key = toObjectKey(
            await uploadFileToRoute({ file, route: 'item_photo' })
          );
          if (key.isError()) throw key.getError();
          await createItem.mutateAsync({
            designId: props.designId,
            kind,
            name: value.name,
            category: value.category,
            vendor: value.vendor || null,
            productUrl: value.productUrl || null,
            photo: { key: key.get(), ...size },
          });
        }
        setOpen(false);
      } catch {
        toast.error(t('moodboard:form.errorMessage'));
      }
    },
  });

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const selectFile = (next: File | undefined) => {
    if (!next) return;
    if (!isAcceptedPhoto(next)) {
      toast.error(t('moodboard:form.unsupportedType'));
      return;
    }
    setFile(next);
    if (!form.getFieldValue('name')) {
      form.setFieldValue('name', fileNameWithoutExtension(next.name));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const pasted = photoFromClipboard(event);
    if (pasted && !props.item) {
      event.preventDefault();
      selectFile(pasted);
    }
  };

  const isEdit = Boolean(props.item);

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen: boolean) => {
        setOpen(isOpen);
        // A fresh form each time the create dialog closes.
        if (!isOpen && !props.item) {
          form.reset();
          setFile(props.initialFile ?? null);
          setKind(props.initialKind ?? 'product');
        }
      }}
    >
      {props.children && <DialogTrigger render={props.children} />}
      <DialogContent className="sm:max-w-md" onPaste={onPaste}>
        <Form form={form} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {isEdit
                ? t('moodboard:form.editTitle')
                : t('moodboard:form.createTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('moodboard:form.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            {!isEdit && kind !== 'extract' && (
              <div className="flex gap-2" role="radiogroup">
                {(['product', 'swatch'] as const).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={kind === value ? 'secondary' : 'ghost'}
                    aria-pressed={kind === value}
                    onClick={() => setKind(value)}
                  >
                    {t(`moodboard:kinds.${value}`)}
                  </Button>
                ))}
              </div>
            )}
            {!isEdit && (
              <>
                <label
                  htmlFor={inputId}
                  className={cn(
                    'flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-md border border-dashed text-sm text-muted-foreground hover:bg-accent/50'
                  )}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    selectFile(event.dataTransfer.files[0]);
                  }}
                >
                  {previewUrl ? (
                    <img
                      src={previewUrl}
                      alt=""
                      className="size-full object-contain"
                    />
                  ) : (
                    <>
                      <UploadCloudIcon className="size-6" />
                      <span>{t('moodboard:form.dropzone')}</span>
                    </>
                  )}
                </label>
                <input
                  id={inputId}
                  type="file"
                  className="sr-only"
                  aria-label={t('moodboard:form.dropzone')}
                  accept={ACCEPTED_PHOTO_TYPES.join(',')}
                  onChange={(event) => selectFile(event.target.files?.[0])}
                />
              </>
            )}
            <FormField>
              <FormFieldLabel>{t('moodboard:form.name')}</FormFieldLabel>
              <form.AppField name="name">
                {(field) => <field.FieldText type="text" />}
              </form.AppField>
            </FormField>
            <FormField>
              <FormFieldLabel>{t('moodboard:form.category')}</FormFieldLabel>
              <form.AppField name="category">
                {(field) => <field.FieldText type="text" autoComplete="off" />}
              </form.AppField>
              <div
                className="flex flex-wrap gap-1"
                aria-label={t('moodboard:form.category')}
              >
                {(categories.data ?? []).slice(0, 10).map((category) => (
                  <Button
                    key={category}
                    type="button"
                    size="xs"
                    variant="secondary"
                    onClick={() => form.setFieldValue('category', category)}
                  >
                    {category}
                  </Button>
                ))}
              </div>
            </FormField>
            <FormField>
              <FormFieldLabel>{t('moodboard:form.vendor')}</FormFieldLabel>
              <form.AppField name="vendor">
                {(field) => <field.FieldText type="text" />}
              </form.AppField>
            </FormField>
            <FormField>
              <FormFieldLabel>{t('moodboard:form.productUrl')}</FormFieldLabel>
              <form.AppField name="productUrl">
                {(field) => (
                  <field.FieldText type="url" placeholder="https://" />
                )}
              </form.AppField>
            </FormField>
          </DialogBody>
          <DialogFooter>
            <form.SubmitButton className="w-full" disabled={!isEdit && !file}>
              {isEdit
                ? t('moodboard:form.saveButton')
                : t('moodboard:form.createButton')}
            </form.SubmitButton>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
