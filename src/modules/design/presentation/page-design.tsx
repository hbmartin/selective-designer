import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveIcon, ArchiveRestoreIcon, DownloadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { PageError } from '@/platform/components/errors/page-error';
import {
  AppPageLayout as PageLayout,
  AppPageLayoutContent as PageLayoutContent,
  AppPageLayoutTopBar as PageLayoutTopBar,
  AppPageLayoutTopBarTitle as PageLayoutTopBarTitle,
} from '@/platform/components/page-layout';
import { Button } from '@/platform/components/ui/button';
import { Skeleton } from '@/platform/components/ui/skeleton';

import { useCurrentScopeKey } from '@/modules/auth/client';
import type { DesignId } from '@/modules/kernel/domain/ids';

import { designQueries } from './wired-queries';

export const PageDesign = (props: { designId: DesignId }) => {
  const { t } = useTranslation(['design']);
  const scopeKey = useCurrentScopeKey();
  const queryClient = useQueryClient();
  const designQuery = useQuery(
    designQueries.getById({ scopeKey, id: props.designId })
  );

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: designQueries.all() });
  const archive = useMutation({
    ...designQueries.archive(),
    onSuccess: async () => {
      toast.success(t('design:detail.archived'));
      await invalidate();
    },
  });
  const unarchive = useMutation({
    ...designQueries.unarchive(),
    onSuccess: async () => {
      toast.success(t('design:detail.unarchived'));
      await invalidate();
    },
  });

  if (designQuery.status === 'error') {
    return <PageError type="unknown-server-error" />;
  }
  const design = designQuery.data;

  return (
    <PageLayout>
      <PageLayoutTopBar
        endActions={
          design && (
            <>
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={
                  // oxlint-disable-next-line jsx-a11y/anchor-has-content -- Button renders the label.
                  <a href={`/api/images/${design.baseImage.id}/download`} />
                }
              >
                <DownloadIcon />
                {t('design:detail.download')}
              </Button>
              {design.archivedAt ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={unarchive.isPending}
                  onClick={() => unarchive.mutate({ id: design.id })}
                >
                  <ArchiveRestoreIcon />
                  {t('design:detail.unarchive')}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={archive.isPending}
                  onClick={() => archive.mutate({ id: design.id })}
                >
                  <ArchiveIcon />
                  {t('design:detail.archive')}
                </Button>
              )}
            </>
          )
        }
      >
        <PageLayoutTopBarTitle>
          {design ? design.name : <Skeleton className="h-5 w-40" />}
        </PageLayoutTopBarTitle>
      </PageLayoutTopBar>
      <PageLayoutContent className="pb-20">
        {design ? (
          <div className="flex flex-col gap-3">
            <div className="overflow-hidden rounded-md border bg-muted">
              <img
                src={design.baseImage.workingUrl}
                alt={t('design:detail.baseImageAlt')}
                className="w-full object-contain"
                style={{
                  aspectRatio: `${design.baseImage.working.width} / ${design.baseImage.working.height}`,
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('design:detail.dimensions', {
                width: design.baseImage.original.width,
                height: design.baseImage.original.height,
              })}
            </p>
          </div>
        ) : (
          <Skeleton className="aspect-video w-full" />
        )}
      </PageLayoutContent>
    </PageLayout>
  );
};
