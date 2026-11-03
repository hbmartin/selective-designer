import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangleIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  ScissorsIcon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Badge } from '@/platform/components/ui/badge';
import { Button } from '@/platform/components/ui/button';
import { Spinner } from '@/platform/components/ui/spinner';

import { useCurrentScopeKey } from '@/modules/auth/client';
import type { DesignId } from '@/modules/kernel/domain/ids';

import { CutoutEditorDialog } from './cutout-editor-dialog';
import { groupByCategory } from './group-items';
import { ItemFormDialog } from './item-form-dialog';
import { SourcePhotos } from './source-photos';
import { moodboardQueries } from './wired-queries';
import type { ItemView } from '../application/use-cases/item-view';

const POLL_MS = 1500;

const ItemCard = (props: { item: ItemView; designId: DesignId }) => {
  const { t } = useTranslation(['moodboard']);
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: moodboardQueries.all() });
  const remove = useMutation({
    ...moodboardQueries.removeItem(),
    onSuccess: async () => {
      toast.success(t('moodboard:panel.removed'));
      await invalidate();
    },
  });
  const retry = useMutation({
    ...moodboardQueries.retryCutout(),
    onSuccess: invalidate,
  });
  const { item } = props;
  const status = item.currentVersion.cutoutStatus;
  const imageUrl = item.cutoutUrl ?? item.photoUrl;

  return (
    <li
      className="flex flex-col gap-1 rounded-md border bg-card p-2"
      data-testid="moodboard-item"
      data-cutout-status={status}
    >
      <div className="relative aspect-square overflow-hidden rounded bg-transparency-grid">
        <img
          src={imageUrl}
          alt={item.name}
          draggable={false}
          className="size-full object-contain"
        />
        {status === 'pending' && (
          <div className="absolute inset-0 flex items-center justify-center gap-1 bg-background/70 text-xs">
            <Spinner />
            {t('moodboard:panel.removingBackground')}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1">
        <span className="truncate text-xs font-medium" title={item.name}>
          {item.name}
        </span>
        <Badge variant="secondary" className="ml-auto shrink-0 text-[10px]">
          {t(`moodboard:kinds.${item.kind}`)}
        </Badge>
      </div>
      {item.vendor && (
        <span className="truncate text-[11px] text-muted-foreground">
          {item.vendor}
        </span>
      )}
      {status === 'failed' && (
        <div className="flex items-center gap-1 text-[11px] text-destructive">
          <AlertTriangleIcon className="size-3" />
          {t('moodboard:panel.cutoutFailed')}
          <Button
            size="xs"
            variant="ghost"
            loading={retry.isPending}
            onClick={() => retry.mutate({ itemId: item.id })}
          >
            <RotateCwIcon />
            {t('moodboard:panel.retry')}
          </Button>
        </div>
      )}
      <div className="flex gap-1">
        <ItemFormDialog designId={props.designId} item={item}>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t('moodboard:panel.edit')}
          >
            <PencilIcon />
          </Button>
        </ItemFormDialog>
        {item.kind !== 'swatch' && status === 'ready' && (
          <CutoutEditorDialog item={item}>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t('moodboard:panel.correctCutout')}
            >
              <ScissorsIcon />
            </Button>
          </CutoutEditorDialog>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label={t('moodboard:panel.remove')}
          loading={remove.isPending}
          onClick={() => remove.mutate({ itemId: item.id })}
        >
          <Trash2Icon />
        </Button>
      </div>
    </li>
  );
};

/** A design's mood board: items by category, plus source photos to extract from. */
export const MoodboardPanel = (props: { designId: DesignId }) => {
  const { t } = useTranslation(['moodboard']);
  const scopeKey = useCurrentScopeKey();
  const itemsQuery = useQuery({
    ...moodboardQueries.byDesign({ scopeKey, designId: props.designId }),
    refetchInterval: (query) =>
      query.state.data?.some(
        (item) => item.currentVersion.cutoutStatus === 'pending'
      )
        ? POLL_MS
        : false,
  });
  const groups = groupByCategory(itemsQuery.data ?? []);

  return (
    <aside
      className="flex flex-col gap-4"
      aria-label={t('moodboard:panel.title')}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('moodboard:panel.title')}</h2>
        <ItemFormDialog designId={props.designId}>
          <Button size="sm" variant="secondary">
            <PlusIcon />
            {t('moodboard:panel.addButton')}
          </Button>
        </ItemFormDialog>
      </div>
      {itemsQuery.status === 'success' && groups.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t('moodboard:panel.empty')}
        </p>
      )}
      {groups.map((group) => (
        <section key={group.category} className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase">
            {group.category}
          </h3>
          <ul className="grid grid-cols-2 gap-2">
            {group.items.map((item) => (
              <ItemCard key={item.id} item={item} designId={props.designId} />
            ))}
          </ul>
        </section>
      ))}
      <SourcePhotos designId={props.designId} />
    </aside>
  );
};
