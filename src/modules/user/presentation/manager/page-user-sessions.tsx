import {
  QueryErrorResetBoundary,
  useMutation,
  useQueryClient,
  useSuspenseInfiniteQuery,
} from '@tanstack/react-query';
import { type ReactNode, Suspense } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { formatRelativeDate } from '@/platform/lib/temporal/date-time';

import { Button } from '@/platform/components/ui/button';
import {
  DataList,
  DataListCell,
  DataListEmptyState,
  DataListErrorState,
  DataListLoadingState,
  DataListRow,
  DataListText,
} from '@/platform/components/ui/datalist';

import {
  useAuthSession,
  useCurrentScopeKey,
  WithPermissions,
} from '@/modules/auth/client';
import {
  type ScopeKey,
  type SessionId,
  type UserId,
} from '@/modules/kernel/domain/ids';
import { userQueries } from '@/modules/user/client';

import { useReauthPrompt } from './use-reauth-prompt';

export const UserSessionsRegion = (props: {
  scopeKey: ScopeKey;
  userId: UserId;
}) => (
  <QueryErrorResetBoundary>
    {({ reset }) => (
      <ErrorBoundary
        onReset={reset}
        fallbackRender={({ resetErrorBoundary }) => (
          <UserSessionsError retryAction={resetErrorBoundary} />
        )}
      >
        <Suspense fallback={<UserSessionsSkeleton />}>
          <UserSessions scopeKey={props.scopeKey} userId={props.userId} />
        </Suspense>
      </ErrorBoundary>
    )}
  </QueryErrorResetBoundary>
);

const UserSessionsHeader = (props: { endAction?: ReactNode }) => {
  const { t } = useTranslation(['user']);

  return (
    <DataListRow>
      <DataListCell>
        <h2 className="text-sm font-medium">
          {t('user:manager.detail.userSessions')}
        </h2>
      </DataListCell>
      {props.endAction}
    </DataListRow>
  );
};

const UserSessionsSkeleton = () => (
  <DataList>
    <UserSessionsHeader />
    <DataListLoadingState />
  </DataList>
);

const UserSessionsError = (props: { retryAction: () => void }) => (
  <DataList>
    <UserSessionsHeader />
    <DataListErrorState retryAction={props.retryAction} />
  </DataList>
);

const UserSessions = (props: { scopeKey: ScopeKey; userId: UserId }) => {
  const { i18n, t } = useTranslation(['user']);
  const sessionsQuery = useSuspenseInfiniteQuery(
    userQueries.getUserSessionsInfinite({
      scopeKey: props.scopeKey,
      userId: props.userId,
      limit: 5,
    })
  );

  const items = sessionsQuery.data.pages.flatMap((page) => page.items);

  return (
    <DataList>
      <UserSessionsHeader
        endAction={
          items.length > 0 ? (
            <WithPermissions permissions={[{ session: ['revoke'] }]}>
              <DataListCell className="flex-none">
                <RevokeAllSessionsButton userId={props.userId} />
              </DataListCell>
            </WithPermissions>
          ) : undefined
        }
      />
      {items.length === 0 ? (
        <DataListEmptyState className="min-h-20">
          {t('user:manager.detail.noSessions')}
        </DataListEmptyState>
      ) : (
        <>
          {items.map((item) => (
            <DataListRow
              key={item.id}
              className="max-md:flex-col max-md:py-2 max-md:[&>div]:py-1"
            >
              <DataListCell>
                <DataListText>
                  {t('user:manager.detail.session', { id: item.id })}
                </DataListText>
              </DataListCell>
              <DataListCell>
                <DataListText className="text-muted-foreground">
                  {t('user:manager.detail.sessionUpdated', {
                    time: formatRelativeDate(item.updatedAt, {
                      locale: i18n.language,
                    }),
                  })}
                </DataListText>
              </DataListCell>
              <DataListCell>
                <DataListText className="text-muted-foreground">
                  {t('user:manager.detail.sessionExpires', {
                    time: formatRelativeDate(item.expiresAt, {
                      locale: i18n.language,
                    }),
                  })}
                </DataListText>
              </DataListCell>
              <WithPermissions permissions={[{ session: ['revoke'] }]}>
                <DataListCell className="flex-none">
                  <RevokeSessionButton
                    userId={props.userId}
                    sessionId={item.id}
                  />
                </DataListCell>
              </WithPermissions>
            </DataListRow>
          ))}
          <DataListRow>
            <DataListCell className="flex-none">
              <Button
                size="xs"
                variant="secondary"
                disabled={!sessionsQuery.hasNextPage}
                onClick={() => sessionsQuery.fetchNextPage()}
                loading={sessionsQuery.isFetchingNextPage}
              >
                {t('user:manager.list.loadMore')}
              </Button>
            </DataListCell>
            <DataListCell>
              <DataListText className="text-xs text-muted-foreground">
                {t('user:manager.list.showing', {
                  count: items.length,
                  total: sessionsQuery.data.pages[0]?.total,
                })}
              </DataListText>
            </DataListCell>
          </DataListRow>
        </>
      )}
    </DataList>
  );
};

const RevokeAllSessionsButton = (props: { userId: UserId }) => {
  const queryClient = useQueryClient();
  const currentSession = useAuthSession();
  const scopeKey = useCurrentScopeKey();
  const { t } = useTranslation(['user']);
  const promptReauth = useReauthPrompt();
  const revokeAllSessions = useMutation({
    ...userQueries.revokeUserSessions(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: userQueries.getUserSessions(scopeKey),
      });
    },
    onError: (error) => {
      if (promptReauth(error)) return;
      toast.error(t('user:manager.detail.revokeAllError'));
    },
  });

  return (
    <Button
      size="xs"
      variant="secondary"
      disabled={currentSession.data?.user.id === props.userId}
      loading={revokeAllSessions.isPending}
      onClick={() => {
        revokeAllSessions.mutate({ id: props.userId });
      }}
    >
      {t('user:manager.detail.revokeAllSessions')}
    </Button>
  );
};

const RevokeSessionButton = (props: {
  userId: UserId;
  sessionId: SessionId;
}) => {
  const queryClient = useQueryClient();
  const currentSession = useAuthSession();
  const scopeKey = useCurrentScopeKey();
  const { t } = useTranslation(['user']);
  const promptReauth = useReauthPrompt();
  const revokeSession = useMutation({
    ...userQueries.revokeUserSession(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: userQueries.getUserSessions(scopeKey),
      });
    },
    onError: (error) => {
      if (promptReauth(error)) return;
      toast.error(t('user:manager.detail.revokeError'));
    },
  });

  return (
    <Button
      size="xs"
      variant="secondary"
      disabled={currentSession.data?.session.id === props.sessionId}
      loading={revokeSession.isPending}
      onClick={() => {
        revokeSession.mutate({
          id: props.userId,
          sessionId: props.sessionId,
        });
      }}
    >
      {t('user:manager.detail.revokeSession')}
    </Button>
  );
};
