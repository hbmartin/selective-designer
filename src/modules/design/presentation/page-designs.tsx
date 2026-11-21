import { getUiState } from '@bearstudio/ui-state';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { ArchiveIcon, ImageIcon, PlusIcon, SearchXIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { match, P } from 'ts-pattern';

import { PageError } from '@/platform/components/errors/page-error';
import {
  AppPageLayout as PageLayout,
  AppPageLayoutContent as PageLayoutContent,
  AppPageLayoutTopBar as PageLayoutTopBar,
  AppPageLayoutTopBarTitle as PageLayoutTopBarTitle,
} from '@/platform/components/page-layout';
import { Button } from '@/platform/components/ui/button';
import { EmptyState } from '@/platform/components/ui/empty-state';
import { SearchInput } from '@/platform/components/ui/search-input';

import { useCurrentScopeKey } from '@/modules/auth/client';

import { CreateDesignDialog } from './create-design-dialog';
import { designQueries } from './wired-queries';
import type { DesignView } from '../application/use-cases/design-view';

export type PageDesignsSearch = { searchTerm: string; archived: boolean };

const DesignCard = ({ design }: { design: DesignView }) => (
  <Link
    to="/app/designs/$designId"
    params={{ designId: design.id }}
    className="group flex flex-col gap-2.5 rounded-xl outline-none"
    data-testid="design-card"
  >
    <div className="aspect-[4/3] overflow-hidden rounded-xl border bg-muted shadow-soft transition duration-300 group-hover:shadow-lift group-focus-visible:ring-[3px] group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background">
      <img
        src={design.baseImage.workingUrl}
        alt=""
        loading="lazy"
        className="size-full object-cover transition duration-500 group-hover:scale-[1.03]"
      />
    </div>
    <span className="truncate px-0.5 text-sm font-medium transition-colors group-hover:text-brand">
      {design.name}
    </span>
  </Link>
);

export const PageDesigns = (props: { search: PageDesignsSearch }) => {
  const { t } = useTranslation(['design']);
  const router = useRouter();
  const scopeKey = useCurrentScopeKey();
  const designsQuery = useInfiniteQuery(
    designQueries.getAllInfinite({
      scopeKey,
      searchTerm: props.search.searchTerm,
      archived: props.search.archived,
    })
  );

  const items = designsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const ui = getUiState((set) =>
    match([designsQuery.status, items.length] as const)
      .with(['pending', P._], () => set('pending'))
      .with(['error', P._], () => set('error'))
      .with(['success', 0], () => set('empty'))
      .with(['success', P._], () => set('default', { items }))
      .exhaustive()
  );

  const navigateSearch = (next: Partial<PageDesignsSearch>) =>
    router.navigate({
      to: '.',
      search: { ...props.search, ...next },
      replace: true,
    });

  return (
    <PageLayout>
      <PageLayoutTopBar
        endActions={
          <>
            <Button
              variant={props.search.archived ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() =>
                navigateSearch({ archived: !props.search.archived })
              }
            >
              <ArchiveIcon />
              {t('design:list.archivedToggle')}
            </Button>
            <CreateDesignDialog>
              <Button size="sm">
                <PlusIcon />
                {t('design:list.newButton')}
              </Button>
            </CreateDesignDialog>
          </>
        }
      >
        <PageLayoutTopBarTitle>
          {props.search.archived
            ? t('design:list.archivedTitle')
            : t('design:list.title')}
        </PageLayoutTopBarTitle>
      </PageLayoutTopBar>
      <PageLayoutContent className="pb-20">
        <SearchInput
          value={props.search.searchTerm}
          changeAction={(value: string) =>
            navigateSearch({ searchTerm: value })
          }
          size="sm"
          className="mb-6 max-w-xs"
        />
        {ui
          .match('pending', () => (
            <div className="grid grid-cols-2 gap-x-5 gap-y-7 md:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }, (_, index) => (
                <div
                  // eslint-disable-next-line @eslint-react/no-array-index-key
                  key={index}
                  className="flex flex-col gap-2.5"
                >
                  <div className="aspect-[4/3] animate-pulse rounded-xl bg-muted" />
                  <div className="h-4 w-2/3 animate-pulse rounded-md bg-muted" />
                </div>
              ))}
            </div>
          ))
          .match('error', () => <PageError type="unknown-server-error" />)
          .match('empty', () =>
            match(props.search)
              .with({ searchTerm: P.string.minLength(1) }, (search) => (
                <EmptyState
                  icon={<SearchXIcon />}
                  title={t('design:list.emptySearch', {
                    searchTerm: search.searchTerm,
                  })}
                />
              ))
              .with({ archived: true }, () => (
                <EmptyState
                  icon={<ArchiveIcon />}
                  title={t('design:list.emptyArchived')}
                />
              ))
              .otherwise(() => (
                <EmptyState
                  icon={<ImageIcon />}
                  title={t('design:list.empty')}
                  description={t('design:list.emptyDescription')}
                  action={
                    <CreateDesignDialog>
                      <Button>
                        <PlusIcon />
                        {t('design:list.newButton')}
                      </Button>
                    </CreateDesignDialog>
                  }
                />
              ))
          )
          .match('default', ({ items }) => (
            <div className="flex flex-col gap-6">
              <div className="grid grid-cols-2 gap-x-5 gap-y-7 md:grid-cols-3 xl:grid-cols-4">
                {items.map((design) => (
                  <DesignCard key={design.id} design={design} />
                ))}
              </div>
              {designsQuery.hasNextPage && (
                <Button
                  variant="ghost"
                  onClick={() => designsQuery.fetchNextPage()}
                  loading={designsQuery.isFetchingNextPage}
                >
                  {t('design:list.loadMore')}
                </Button>
              )}
            </div>
          ))
          .exhaustive()}
      </PageLayoutContent>
    </PageLayout>
  );
};
