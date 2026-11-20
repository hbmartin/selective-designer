import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page, userEvent } from 'vitest/browser';
import type { PropsWithChildren } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { PageOnboarding } from '@/modules/auth/presentation/page-onboarding';
import '@/platform/lib/i18n';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  refetch: vi.fn(),
  invalidate: vi.fn(),
  clear: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouter: () => ({ invalidate: mocks.invalidate }),
}));

vi.mock('@/modules/auth/client', () => ({
  clearAllQueryStateForAuthBoundary: mocks.clear,
  useAuthSession: () => ({
    data: { user: { name: 'New User', email: 'onboarding@example.com' } },
    refetch: mocks.refetch,
  }),
}));

vi.mock('@/modules/account/client', () => ({
  accountQueries: {
    submitOnboarding: () => ({
      mutationKey: ['test-onboarding'],
      mutationFn: mocks.save,
    }),
  },
}));

vi.mock('@/modules/auth/presentation/layout-login', () => ({
  LayoutLogin: ({ children }: PropsWithChildren) => <>{children}</>,
}));

vi.mock('@/modules/auth/presentation/confirm-signout', () => ({
  ConfirmSignOut: ({ children }: PropsWithChildren) => <>{children}</>,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.error } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockResolvedValue(undefined);
  mocks.refetch.mockResolvedValue({ data: {} });
  mocks.invalidate.mockResolvedValue(undefined);
});

test('allows retry after the saved profile cannot refresh its session', async () => {
  const user = userEvent.setup();
  mocks.refetch.mockRejectedValueOnce(new Error('Session unavailable'));
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PageOnboarding />
    </QueryClientProvider>
  );

  const submit = page.getByRole('button', { name: 'Continue', exact: true });
  await user.click(submit);
  await expect.poll(() => mocks.error.mock.calls.length).toBe(1);
  await expect.element(submit).toBeEnabled();
  expect(mocks.refetch).toHaveBeenCalledWith({ throwOnError: true });
  expect(mocks.invalidate).not.toHaveBeenCalled();

  await user.click(submit);
  await expect.poll(() => mocks.invalidate.mock.calls.length).toBe(1);
  await expect.element(submit).toBeEnabled();
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.clear).toHaveBeenCalledWith(client);
});
