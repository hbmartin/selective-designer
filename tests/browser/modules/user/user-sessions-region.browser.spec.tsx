import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from '@tests/utils';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import {
  toScopeKey,
  toUserId,
  unwrapParseResult,
} from '@/modules/kernel/testing';
import { UserSessionsRegion } from '@/modules/user/presentation/manager/page-user-sessions';

const sessionsQueryFn = vi.hoisted(() => vi.fn());

vi.mock('@/modules/user/client', () => ({
  userQueries: {
    getUserSessionsInfinite: (input: {
      scopeKey: string;
      userId: string;
      limit: number;
    }) => ({
      queryKey: ['test-user-sessions', input] as const,
      queryFn: sessionsQueryFn,
      initialPageParam: undefined,
      getNextPageParam: (page: { nextCursor?: string }) => page.nextCursor,
    }),
  },
}));

const scopeKey = unwrapParseResult(toScopeKey('user:user-1:role:user'));
const userId = unwrapParseResult(toUserId('user-1'));
const emptySessions = { items: [], nextCursor: undefined, total: 0 };

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

beforeEach(() => sessionsQueryFn.mockReset());

test('sessions suspend behind a layout-matched section skeleton', async () => {
  let resolveSessions!: (sessions: typeof emptySessions) => void;
  sessionsQueryFn.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveSessions = resolve;
    })
  );

  render(
    <QueryClientProvider client={createQueryClient()}>
      <UserSessionsRegion scopeKey={scopeKey} userId={userId} />
    </QueryClientProvider>
  );

  await expect.element(page.getByText('User Sessions')).toBeInTheDocument();
  expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(6);

  resolveSessions(emptySessions);
  await expect.element(page.getByText('No user sessions')).toBeInTheDocument();
});

test('sessions errors stay section-local and retry through the query boundary', async () => {
  const consoleError = vi
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  sessionsQueryFn
    .mockRejectedValueOnce(new Error('sessions unavailable'))
    .mockResolvedValueOnce(emptySessions);

  render(
    <QueryClientProvider client={createQueryClient()}>
      <UserSessionsRegion scopeKey={scopeKey} userId={userId} />
    </QueryClientProvider>
  );

  await expect
    .element(page.getByText('Something went wrong'))
    .toBeInTheDocument();
  (
    page.getByRole('button', { name: 'Retry' }).element() as HTMLElement
  ).click();

  await expect.element(page.getByText('No user sessions')).toBeInTheDocument();
  expect(sessionsQueryFn).toHaveBeenCalledTimes(2);
  consoleError.mockRestore();
});
