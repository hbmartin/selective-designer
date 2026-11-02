import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from '@tanstack/react-query';
import { page } from '@tests/utils';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import {
  beginOptimisticCurrentSessionNameUpdate,
  reconcileOptimisticCurrentSessionNameUpdate,
  rollbackOptimisticCurrentSessionNameUpdate,
} from '@/modules/account/presentation/optimistic-current-session';
import type { CurrentSession } from '@/modules/auth';
import {
  toEmailAddress,
  toScopeKey,
  toSessionId,
  toUserId,
  unwrapParseResult,
} from '@/modules/kernel/testing';

const currentSession: CurrentSession = {
  user: {
    id: unwrapParseResult(toUserId('user-1')),
    email: unwrapParseResult(toEmailAddress('user@example.com')),
    name: 'Before',
    role: 'user',
  },
  session: {
    id: unwrapParseResult(toSessionId('session-1')),
  },
  scope: {
    userId: unwrapParseResult(toUserId('user-1')),
    role: 'user',
  },
  scopeKey: unwrapParseResult(toScopeKey('user:user-1:role:user')),
};

test('shared session observers roll back and reconcile optimistic names', async () => {
  const queryClient = new QueryClient();
  const queryKey = ['auth', 'current-session'] as const;
  let authoritativeSession = currentSession;
  const queryFn = vi.fn(async () => authoritativeSession);
  queryClient.setQueryData(queryKey, currentSession);

  const SessionName = (props: { location: string }) => {
    const session = useQuery(
      queryOptions({ queryKey, queryFn, staleTime: Infinity })
    );
    return <span data-testid={props.location}>{session.data?.user.name}</span>;
  };

  render(
    <QueryClientProvider client={queryClient}>
      <SessionName location="shell" />
      <SessionName location="account" />
    </QueryClientProvider>
  );

  const rollbackContext = await beginOptimisticCurrentSessionNameUpdate({
    queryClient,
    queryKey,
    name: 'Optimistic',
  });
  await expect
    .element(page.getByTestId('shell'))
    .toHaveTextContent('Optimistic');
  await expect
    .element(page.getByTestId('account'))
    .toHaveTextContent('Optimistic');

  rollbackOptimisticCurrentSessionNameUpdate({
    queryClient,
    queryKey,
    context: rollbackContext,
  });
  await expect.element(page.getByTestId('shell')).toHaveTextContent('Before');
  await expect.element(page.getByTestId('account')).toHaveTextContent('Before');

  await beginOptimisticCurrentSessionNameUpdate({
    queryClient,
    queryKey,
    name: 'Optimistic again',
  });
  authoritativeSession = {
    ...currentSession,
    user: { ...currentSession.user, name: 'Reconciled' },
  };
  await reconcileOptimisticCurrentSessionNameUpdate({ queryClient, queryKey });

  await expect
    .element(page.getByTestId('shell'))
    .toHaveTextContent('Reconciled');
  await expect
    .element(page.getByTestId('account'))
    .toHaveTextContent('Reconciled');
  expect(queryFn).toHaveBeenCalledOnce();
});
