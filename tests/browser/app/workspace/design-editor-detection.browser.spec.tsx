import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { okValue } from '@tests/support/result';
import { page } from '@tests/utils';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { DesignEditor } from '@/app/workspace/presentation/design-editor';
import { toDesignId, toImageId, toScopeKey } from '@/modules/kernel';
import { segmentationQueries } from '@/modules/segmentation/client';
import { Route } from '@/routes/app/designs/$designId/edit';

const rpc = vi.hoisted(() => ({ regionsGet: vi.fn(), retry: vi.fn() }));
vi.mock('@/modules/segmentation/client', async () => {
  const { createSegmentationQueries } =
    await import('@/modules/segmentation/presentation/queries');
  return {
    segmentationQueries: createSegmentationQueries({
      regionsGet: rpc.regionsGet,
      regionsRetryDetection: rpc.retry,
      regionsSegment: vi.fn(),
      regionsCreateManual: vi.fn(),
      regionsUpdate: vi.fn(),
      regionsRemove: vi.fn(),
    }),
  };
});
vi.mock('@/modules/auth/client', () => ({
  useCurrentScopeKey: () => 'owner',
  useCurrentSessionQuery: () => ({ data: null }),
  useAuth: () => ({}),
  authClient: {},
}));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/modules/design/client', () => ({
  designQueries: {
    getById: () => ({
      queryKey: ['design'],
      staleTime: Infinity,
      queryFn: async () => ({
        id: 'design',
        name: 'Villa',
        baseImage: { id: 'base' },
      }),
    }),
  },
}));
vi.mock('@/modules/moodboard/client', () => ({
  moodboardQueries: {
    byDesign: () => ({
      queryKey: ['items'],
      staleTime: Infinity,
      queryFn: async () => [],
    }),
  },
}));
vi.mock('@/modules/rendering/client', () => ({
  renderingQueries: {
    source: () => ({
      queryKey: ['source'],
      queryFn: async () => ({ designId: 'design' }),
    }),
    draft: () => ({ queryKey: ['draft'], queryFn: async () => ({}) }),
  },
}));
vi.mock('@/app/workspace/presentation', async () => ({
  DesignEditor: (await import('@/app/workspace/presentation/design-editor'))
    .DesignEditor,
}));
vi.mock('@/modules/rendering/presentation', () => ({
  RenderingEditor: ({ header }: { header: ReactNode }) => (
    <section>{header}</section>
  ),
}));
vi.mock('@/platform/components/page-layout', () => ({
  AppPageLayout: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  AppPageLayoutContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AppPageLayoutTopBar: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  AppPageLayoutTopBarTitle: ({ children }: { children: ReactNode }) => (
    <h1>{children}</h1>
  ),
}));
vi.mock('@/platform/components/upload/upload-file', () => ({
  uploadFileToRoute: vi.fn(),
}));

const input = {
  scopeKey: okValue(toScopeKey('owner')),
  imageId: okValue(toImageId('base')),
};
const clients: QueryClient[] = [];
afterEach(() => {
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.resetAllMocks();
});

const enterEditor = async (client: QueryClient) => {
  const loader = Route.options.loader;
  if (typeof loader !== 'function') throw new Error('Editor loader missing');
  await loader({
    context: { queryClient: client, scopeKey: input.scopeKey },
    params: { designId: 'design' },
    deps: {},
    cause: 'enter',
  } as never);
};
const mountEditor = (client: QueryClient) =>
  render(
    <QueryClientProvider client={client}>
      <DesignEditor
        designId={okValue(toDesignId('design'))}
        sourceImageId={input.imageId}
      />
    </QueryClientProvider>
  );

it.each([
  { timing: 'completed', type: 'idle' },
  { timing: 'in flight', type: 'idle' },
  { timing: 'completed', type: 'waiting' },
  { timing: 'in flight', type: 'waiting' },
] as const)(
  'shares a $timing loader refresh returning $type with the real editor',
  async ({ timing, type }) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const options = segmentationQueries.regions(input);
    client.setQueryData(options.queryKey, {
      regions: [],
      detection: { type: 'idle', omissions: [] },
    });
    const pending = Promise.withResolvers<{
      regions: [];
      detection: { type: typeof type; remainingMs: number; omissions: [] };
    }>();
    rpc.regionsGet.mockReturnValue(pending.promise);
    await enterEditor(client);
    expect(rpc.regionsGet).toHaveBeenCalledOnce();
    const response = {
      regions: [] as [],
      detection: { type, remainingMs: 60_000, omissions: [] as [] },
    };
    if (timing === 'completed') {
      pending.resolve(response);
      await vi.waitFor(() =>
        expect(client.getQueryData(options.queryKey)).toEqual(response)
      );
    }
    mountEditor(client);
    pending.resolve(response);
    await expect.element(page.getByRole('heading')).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(client.getQueryData(options.queryKey)).toEqual(response)
    );
    if (type === 'waiting')
      await expect
        .element(page.getByRole('status'))
        .toHaveTextContent('segmentation:list.waitingForDetection');
    expect(rpc.regionsGet).toHaveBeenCalledOnce();
  }
);

it('shows Retry when polling reaches the recovery deadline', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  rpc.regionsGet
    .mockResolvedValueOnce({
      regions: [],
      detection: { type: 'waiting', remainingMs: 1, omissions: [] },
    })
    .mockResolvedValue({
      regions: [],
      detection: { type: 'retryable', omissions: [] },
    });
  await enterEditor(client);
  mountEditor(client);
  await expect
    .element(
      page.getByRole('button', { name: 'segmentation:list.retryDetection' })
    )
    .toBeVisible();
  expect(rpc.regionsGet).toHaveBeenCalledTimes(2);
});
