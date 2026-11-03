import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  AppPageLayout as PageLayout,
  AppPageLayoutContent as PageLayoutContent,
  AppPageLayoutTopBar as PageLayoutTopBar,
  AppPageLayoutTopBarTitle as PageLayoutTopBarTitle,
} from '@/platform/components/page-layout';
import { Button } from '@/platform/components/ui/button';
import { Skeleton } from '@/platform/components/ui/skeleton';
import { uploadFileToRoute } from '@/platform/components/upload/upload-file';

import { useCurrentScopeKey } from '@/modules/auth/client';
import { designQueries } from '@/modules/design/client';
import type { DesignId, ImageId } from '@/modules/kernel/domain/ids';
import { moodboardQueries } from '@/modules/moodboard/client';
import {
  type EditorItem,
  type EditorRegion,
  RenderingEditor,
} from '@/modules/rendering/presentation';
import {
  segmentationQueries,
  useRegionsPolling,
} from '@/modules/segmentation/client';

/**
 * The design editor screen: composes the rendering editor with the mood
 * board (items) and segmentation (regions, click and drawn selections).
 */
export const DesignEditor = (props: {
  designId: DesignId;
  sourceImageId: ImageId;
}) => {
  const { t } = useTranslation(['rendering', 'segmentation']);
  const scopeKey = useCurrentScopeKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const regionsPolling = useRegionsPolling();

  const design = useQuery(
    designQueries.getById({ scopeKey, id: props.designId })
  );
  const items = useQuery(
    moodboardQueries.byDesign({ scopeKey, designId: props.designId })
  );
  const regions = useQuery({
    ...segmentationQueries.regions({ scopeKey, imageId: props.sourceImageId }),
    refetchInterval: regionsPolling,
  });
  const invalidateRegions = () =>
    queryClient.invalidateQueries({ queryKey: segmentationQueries.all() });
  const segment = useMutation({
    ...segmentationQueries.segment(),
    onSuccess: invalidateRegions,
  });
  const createManual = useMutation({
    ...segmentationQueries.createManual(),
    onSuccess: invalidateRegions,
  });

  const editorItems: EditorItem[] = (items.data ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    category: item.category,
    imageUrl: item.cutoutUrl ?? item.photoUrl,
    imageSize: {
      width: item.currentVersion.photo.width,
      height: item.currentVersion.photo.height,
    },
    ready:
      item.kind === 'swatch' || item.currentVersion.cutoutStatus === 'ready',
  }));
  const editorRegions: EditorRegion[] = (regions.data ?? []).map((region) => ({
    id: region.id,
    label: region.label,
    box: region.box,
    isSuggestion: region.isSuggestion,
  }));
  const isBaseImage = design.data?.baseImage.id === props.sourceImageId;

  return (
    <PageLayout>
      <PageLayoutTopBar
        startActions={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('rendering:editor.back')}
            onClick={() =>
              navigate({
                to: '/app/designs/$designId',
                params: { designId: props.designId },
              })
            }
          >
            <ArrowLeftIcon />
          </Button>
        }
      >
        <PageLayoutTopBarTitle>
          {design.data ? (
            t('rendering:editor.title', { name: design.data.name })
          ) : (
            <Skeleton className="h-5 w-40" />
          )}
        </PageLayoutTopBarTitle>
      </PageLayoutTopBar>
      <PageLayoutContent className="pb-20">
        <RenderingEditor
          imageId={props.sourceImageId}
          items={editorItems}
          regions={editorRegions}
          header={
            design.data && !isBaseImage ? (
              <p className="text-xs text-muted-foreground">
                {t('rendering:editor.fromResult')}
              </p>
            ) : null
          }
          onSegmentAt={async (point) => {
            try {
              await segment.mutateAsync({
                imageId: props.sourceImageId,
                label: '',
                prompt: {
                  type: 'click',
                  points: [{ ...point, positive: true }],
                },
              });
            } catch {
              toast.error(t('segmentation:errors.segmentFailed'));
            }
          }}
          onCreateRegion={async ({ mask, box, source }) => {
            try {
              const maskKey = await uploadFileToRoute({
                file: new File([mask], 'region.png', { type: 'image/png' }),
                route: 'region_mask',
              });
              await createManual.mutateAsync({
                imageId: props.sourceImageId,
                source,
                label: '',
                maskKey,
                box,
              });
            } catch {
              toast.error(t('segmentation:errors.segmentFailed'));
            }
          }}
          onSubmitted={() =>
            navigate({
              to: '/app/designs/$designId',
              params: { designId: props.designId },
            })
          }
        />
      </PageLayoutContent>
    </PageLayout>
  );
};
