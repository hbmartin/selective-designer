import type { QueryClient, QueryKey } from '@tanstack/react-query';

import type { CurrentSession } from '@/modules/auth';

export type OptimisticCurrentSessionNameContext = {
  previousSession: CurrentSession | null | undefined;
};

export const projectCurrentSessionName = (
  currentSession: CurrentSession | null | undefined,
  name: string
): CurrentSession | null | undefined =>
  currentSession
    ? {
        ...currentSession,
        user: {
          ...currentSession.user,
          name,
        },
      }
    : currentSession;

export const beginOptimisticCurrentSessionNameUpdate = async (props: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  name: string;
}): Promise<OptimisticCurrentSessionNameContext> => {
  await props.queryClient.cancelQueries({ queryKey: props.queryKey });
  const previousSession = props.queryClient.getQueryData<CurrentSession | null>(
    props.queryKey
  );

  props.queryClient.setQueryData<CurrentSession | null>(
    props.queryKey,
    (currentSession) => projectCurrentSessionName(currentSession, props.name)
  );

  return { previousSession };
};

export const rollbackOptimisticCurrentSessionNameUpdate = (props: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  context: OptimisticCurrentSessionNameContext | undefined;
}) => {
  if (props.context?.previousSession === undefined) return;

  props.queryClient.setQueryData(props.queryKey, props.context.previousSession);
};

export const reconcileOptimisticCurrentSessionNameUpdate = (props: {
  queryClient: QueryClient;
  queryKey: QueryKey;
}) => props.queryClient.invalidateQueries({ queryKey: props.queryKey });
