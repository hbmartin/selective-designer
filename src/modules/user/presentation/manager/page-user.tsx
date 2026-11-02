import { getUiState } from '@bearstudio/ui-state';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertCircleIcon, PencilLineIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { match, P } from 'ts-pattern';

import { formatDate } from '@/platform/lib/temporal/date-time';
import { useNavigateBack } from '@/platform/hooks/use-navigate-back';

import { BackButton } from '@/platform/components/back-button';
import { PageError } from '@/platform/components/errors/page-error';
import {
  ManagerPageLayout as PageLayout,
  ManagerPageLayoutContent as PageLayoutContent,
  ManagerPageLayoutTopBar as PageLayoutTopBar,
  ManagerPageLayoutTopBarTitle as PageLayoutTopBarTitle,
} from '@/platform/components/page-layout';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@/platform/components/ui/avatar';
import { Badge } from '@/platform/components/ui/badge';
import { Button } from '@/platform/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/platform/components/ui/card';
import { ConfirmResponsiveDrawer } from '@/platform/components/ui/confirm-responsive-drawer';
import { ResponsiveIconButton } from '@/platform/components/ui/responsive-icon-button';
import { Skeleton } from '@/platform/components/ui/skeleton';
import { Spinner } from '@/platform/components/ui/spinner';

import {
  useAuthSession,
  useCurrentScopeKey,
  WithPermissions,
} from '@/modules/auth/client';
import { isServerFnError } from '@/modules/kernel/client';
import { type UserId } from '@/modules/kernel/domain/ids';
import { userQueries } from '@/modules/user/client';

import { UserSessionsRegion } from './page-user-sessions';
import { useReauthPrompt } from './use-reauth-prompt';

const isNotFoundError = (error: unknown) =>
  isServerFnError(error) && error.code === 'NOT_FOUND';

export const PageUser = (props: { userId: UserId }) => {
  const queryClient = useQueryClient();
  const { navigateBack } = useNavigateBack();
  const session = useAuthSession();
  const { t } = useTranslation(['user']);
  const scopeKey = useCurrentScopeKey();
  const promptReauth = useReauthPrompt();
  const userId = props.userId;
  const userQuery = useQuery(userQueries.getById({ id: userId, scopeKey }));

  const deleteUserMutation = useMutation(userQueries.deleteById());

  const deleteUser = async () => {
    try {
      await deleteUserMutation.mutateAsync({ id: userId });
      await queryClient.invalidateQueries({
        queryKey: userQueries.getAll(scopeKey),
        type: 'all',
      });
      queryClient.removeQueries({
        queryKey: userQueries.getById({ id: userId, scopeKey }).queryKey,
      });

      toast.success(t('user:manager.detail.userDeleted'));

      // Redirect
      navigateBack();
    } catch (error) {
      if (promptReauth(error)) return;
      toast.error(t('user:manager.detail.deleteError'));
    }
  };

  const ui = getUiState((set) =>
    match(userQuery)
      .with({ status: 'pending' }, () => set('pending'))
      .with({ status: 'error', error: P.when(isNotFoundError) }, () =>
        set('not-found')
      )
      .with({ status: 'error' }, () => set('error'))
      .with({ status: 'success', data: P.select() }, (user) =>
        set('default', { user })
      )
      .exhaustive()
  );

  return (
    <PageLayout>
      <PageLayoutTopBar
        startActions={<BackButton />}
        endActions={
          <>
            {session.data?.user.id !== userId && (
              <WithPermissions
                permissions={[
                  {
                    user: ['delete'],
                  },
                ]}
              >
                <ConfirmResponsiveDrawer
                  confirmAction={() => deleteUser()}
                  title={t('user:manager.detail.confirmDeleteTitle', {
                    user: userQuery.data?.name ?? userQuery.data?.email ?? '--',
                  })}
                  description={t(
                    'user:manager.detail.confirmDeleteDescription'
                  )}
                  confirmText={t('user:manager.detail.deleteButton.label')}
                  confirmVariant="destructive"
                >
                  <ResponsiveIconButton
                    variant="ghost"
                    label={t('user:manager.detail.deleteButton.label')}
                    size="sm"
                  >
                    <Trash2Icon />
                  </ResponsiveIconButton>
                </ConfirmResponsiveDrawer>
              </WithPermissions>
            )}
          </>
        }
      >
        <PageLayoutTopBarTitle>
          {ui
            .match('pending', () => <Skeleton className="h-4 w-48" />)
            .match(['not-found', 'error'], () => (
              <AlertCircleIcon className="size-4 text-muted-foreground" />
            ))
            .match('default', ({ user }) => <>{user.name || user.email}</>)
            .exhaustive()}
        </PageLayoutTopBarTitle>
      </PageLayoutTopBar>
      <PageLayoutContent>
        {ui
          .match('pending', () => <Spinner full />)
          .match('not-found', () => <PageError type="404" />)
          .match('error', () => <PageError type="unknown-server-error" />)
          .match('default', ({ user }) => (
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
              <Card className="relative flex-1">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <Avatar>
                      <AvatarImage
                        src={user.image ?? undefined}
                        alt={user.name ?? ''}
                      />
                      <AvatarFallback variant="boring" name={user.name ?? ''} />
                    </Avatar>
                    <div className="flex flex-1 flex-col gap-0.5">
                      <CardTitle>
                        {user.name || (
                          <span className="text-xs text-muted-foreground">
                            {t('user:common.name.notAvailable')}
                          </span>
                        )}
                      </CardTitle>
                      <CardDescription>{user.email}</CardDescription>
                    </div>
                    <WithPermissions permissions={[{ user: ['update'] }]}>
                      <Link
                        to="/manager/users/$id/update"
                        params={{ id: userId }}
                        className="-m-2 self-start"
                      >
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          render={<span />}
                          nativeButton={false}
                        >
                          <PencilLineIcon />
                          <span className="sr-only">
                            {t('user:manager.detail.editUser')}
                          </span>
                        </Button>
                        <span className="absolute inset-0" />
                      </Link>
                    </WithPermissions>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex items-center gap-4">
                    <Badge
                      variant={user.role === 'admin' ? 'default' : 'secondary'}
                    >
                      {user.role ?? '-'}
                    </Badge>
                    <p className="text-sm text-muted-foreground">
                      {user.onboardedAt ? (
                        <>
                          {t('user:common.onboardingStatus.onboardedAt', {
                            time: formatDate(
                              user.onboardedAt,
                              'DD/MM/YYYY [at] HH:mm'
                            ),
                          })}
                        </>
                      ) : (
                        <>{t('user:common.onboardingStatus.notOnboarded')}</>
                      )}
                    </p>
                  </div>
                </CardContent>
              </Card>

              <div className="flex min-w-0 flex-2 flex-col">
                <WithPermissions permissions={[{ session: ['list'] }]}>
                  <UserSessionsRegion scopeKey={scopeKey} userId={userId} />
                </WithPermissions>
              </div>
            </div>
          ))
          .exhaustive()}
      </PageLayoutContent>
    </PageLayout>
  );
};
