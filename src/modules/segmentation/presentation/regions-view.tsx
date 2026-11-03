import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckIcon,
  MousePointerClickIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import { type FormEvent, type MouseEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Badge } from '@/platform/components/ui/badge';
import { Button } from '@/platform/components/ui/button';
import { Input } from '@/platform/components/ui/input';

import { useCurrentScopeKey } from '@/modules/auth/client';
import type { ImageId } from '@/modules/kernel/domain/ids';

import { RegionOverlay } from './region-overlay';
import { useRegionsPolling } from './use-regions-polling';
import { segmentationQueries } from './wired-queries';
import type { RegionView } from '../application/use-cases/regions';

export type RegionsViewProps = {
  imageId: ImageId;
  imageUrl: string;
  width: number;
  height: number;
};

/**
 * The image with its regions: hover a region to highlight it, click the image
 * in select mode to segment at that point, or describe what to find.
 */
export const RegionsView = (props: RegionsViewProps) => {
  const { t } = useTranslation(['segmentation']);
  const scopeKey = useCurrentScopeKey();
  const queryClient = useQueryClient();
  const [selectMode, setSelectMode] = useState(false);
  const [text, setText] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const regionsPolling = useRegionsPolling();
  const [showAll, setShowAll] = useState(false);

  const regionsQuery = useQuery({
    ...segmentationQueries.regions({ scopeKey, imageId: props.imageId }),
    refetchInterval: regionsPolling,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: segmentationQueries.all() });
  const segment = useMutation({
    ...segmentationQueries.segment(),
    onSuccess: invalidate,
    onError: () => toast.error(t('segmentation:errors.segmentFailed')),
  });
  const update = useMutation({
    ...segmentationQueries.update(),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    ...segmentationQueries.remove(),
    onSuccess: invalidate,
  });

  const regions = regionsQuery.data ?? [];

  const onImageClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!selectMode || segment.isPending) return;
    const rect = event.currentTarget.getBoundingClientRect();
    segment.mutate({
      imageId: props.imageId,
      label: '',
      prompt: {
        type: 'click',
        points: [
          {
            x: (event.clientX - rect.left) / rect.width,
            y: (event.clientY - rect.top) / rect.height,
            positive: true,
          },
        ],
      },
    });
  };

  const onFind = (event: FormEvent) => {
    event.preventDefault();
    const query = text.trim();
    if (!query) return;
    segment.mutate(
      {
        imageId: props.imageId,
        label: query,
        prompt: { type: 'text', text: query },
      },
      { onSuccess: () => setText('') }
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={selectMode ? 'secondary' : 'ghost'}
          aria-pressed={selectMode}
          onClick={() => setSelectMode((value) => !value)}
        >
          <MousePointerClickIcon />
          {t('segmentation:tools.clickSelect')}
        </Button>
        <Button
          size="sm"
          variant={showAll ? 'secondary' : 'ghost'}
          aria-pressed={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {t('segmentation:tools.showAll')}
        </Button>
        <form onSubmit={onFind} className="flex flex-1 items-center gap-2">
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('segmentation:tools.findPlaceholder')}
            aria-label={t('segmentation:tools.findPlaceholder')}
            size="sm"
          />
          <Button
            size="sm"
            type="submit"
            variant="secondary"
            loading={segment.isPending}
          >
            <SearchIcon />
            {t('segmentation:tools.find')}
          </Button>
        </form>
      </div>

      <div
        className="relative overflow-hidden rounded-md border bg-muted"
        style={{ aspectRatio: `${props.width} / ${props.height}` }}
        data-testid="regions-image"
        onClick={onImageClick}
        role={selectMode ? 'button' : undefined}
        aria-label={
          selectMode ? t('segmentation:tools.clickSelect') : undefined
        }
      >
        <img
          src={props.imageUrl}
          alt=""
          draggable={false}
          className={selectMode ? 'size-full cursor-crosshair' : 'size-full'}
        />
        {regions.map((region) => (
          <RegionOverlay
            key={region.id}
            region={region}
            active={region.id === activeId}
          />
        ))}
      </div>

      <section
        aria-label={t('segmentation:list.title')}
        className="flex flex-col gap-1"
      >
        <h3 className="text-sm font-medium">
          {t('segmentation:list.title')}{' '}
          <span className="text-muted-foreground">({regions.length})</span>
        </h3>
        <ul className="flex flex-wrap gap-1">
          {regions.map((region: RegionView) => (
            <li
              key={region.id}
              data-testid="region-chip"
              data-source={region.source}
              className="flex items-center gap-1 rounded border bg-card py-0.5 pr-0.5 pl-2 text-xs"
              onMouseEnter={() => setActiveId(region.id)}
              onMouseLeave={() => setActiveId(null)}
            >
              <span>{region.label}</span>
              <Badge variant="secondary" className="text-[10px]">
                {t(`segmentation:sources.${region.source}`)}
              </Badge>
              {region.isSuggestion && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t('segmentation:list.confirm')}
                  onClick={() =>
                    update.mutate({ regionId: region.id, confirm: true })
                  }
                >
                  <CheckIcon />
                </Button>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t('segmentation:list.remove')}
                onClick={() => remove.mutate({ regionId: region.id })}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};
