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
  success: vi.fn(),
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

vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockResolvedValue(undefined);
  mocks.refetch.mockResolvedValue({ data: { user: { name: 'Saved User' } } });
  mocks.invalidate.mockResolvedValue(undefined);
});

function renderOnboarding() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PageOnboarding />
    </QueryClientProvider>
  );
  return {
    client,
    submit: page.getByRole('button', { name: 'Continue', exact: true }),
    name: page.getByRole('textbox'),
  };
}

test('retries session refresh without saving the completed profile again', async () => {
  const user = userEvent.setup();
  mocks.refetch.mockRejectedValueOnce(new Error('Session unavailable'));
  const { client, submit, name } = renderOnboarding();
  await user.click(submit);
  await expect.poll(() => mocks.error.mock.calls.length).toBe(1);
  await expect.element(submit).toBeEnabled();
  await expect.element(name).toHaveAttribute('readonly');
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith(
    expect.stringContaining('profile was saved')
  );
  expect(mocks.invalidate).not.toHaveBeenCalled();
  await user.click(submit);
  await expect.poll(() => mocks.success.mock.calls.length).toBe(1);
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.refetch).toHaveBeenCalledTimes(2);
  expect(mocks.refetch).toHaveBeenCalledWith({ throwOnError: true });
  expect(mocks.clear).toHaveBeenCalledWith(client);
  expect(mocks.success).toHaveBeenCalledWith(
    expect.stringContaining('Saved User')
  );
});

test('leaves failed persistence editable and retries the save', async () => {
  mocks.save.mockRejectedValueOnce(new Error('Database unavailable'));
  const { submit, name } = renderOnboarding();
  await userEvent.click(submit);
  await expect.poll(() => mocks.error.mock.calls.length).toBe(1);
  await expect.element(name).not.toHaveAttribute('readonly');
  await expect.element(submit).toBeEnabled();
  expect(mocks.refetch).not.toHaveBeenCalled();
  await userEvent.click(submit);
  await expect.poll(() => mocks.success.mock.calls.length).toBe(1);
  expect(mocks.save).toHaveBeenCalledTimes(2);
});

test('retries route invalidation without resaving and uses the authoritative name', async () => {
  mocks.invalidate.mockRejectedValueOnce(new Error('Route unavailable'));
  mocks.refetch.mockResolvedValue({
    data: { user: { name: 'Concurrent Winner' } },
  });
  const { submit } = renderOnboarding();
  await userEvent.click(submit);
  await expect.poll(() => mocks.error.mock.calls.length).toBe(1);
  await expect.element(submit).toBeEnabled();
  expect(mocks.success).not.toHaveBeenCalled();
  await userEvent.click(submit);
  await expect.poll(() => mocks.success.mock.calls.length).toBe(1);
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.success).toHaveBeenCalledWith(
    expect.stringContaining('Concurrent Winner')
  );
});

test.each(['save', 'refetch', 'invalidate'] as const)(
  'keeps Continue pending throughout %s',
  async (phase) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks[phase].mockImplementationOnce(async () => {
      await pending;
      return phase === 'refetch'
        ? { data: { user: { name: 'Saved User' } } }
        : undefined;
    });
    const { submit, name } = renderOnboarding();
    await userEvent.click(submit);
    await expect.poll(() => mocks[phase].mock.calls.length).toBe(1);
    await expect.element(submit).toBeDisabled();
    await expect.element(name).toHaveAttribute('readonly');
    expect(mocks.save).toHaveBeenCalledTimes(1);
    release();
    await expect.poll(() => mocks.success.mock.calls.length).toBe(1);
  }
);

test('lets the route guard handle a missing refreshed session without a success toast', async () => {
  mocks.refetch.mockResolvedValue({ data: null });
  const { submit } = renderOnboarding();
  await userEvent.click(submit);
  await expect.poll(() => mocks.invalidate.mock.calls.length).toBe(1);
  await expect.element(submit).toBeEnabled();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.error).not.toHaveBeenCalled();
});
