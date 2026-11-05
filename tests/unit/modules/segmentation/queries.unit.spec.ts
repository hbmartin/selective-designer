import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { okValue } from '@tests/support/result';
import { expect, it, vi } from 'vitest';

import { toImageId, toScopeKey } from '@/modules/kernel/domain/ids';
import {
  createSegmentationQueries,
  type SegmentationQueryFacade,
} from '@/modules/segmentation/client';

const queries = (regionsGet: SegmentationQueryFacade['regionsGet']) =>
  createSegmentationQueries({
    regionsGet,
    regionsRetryDetection: vi.fn(),
    regionsSegment: vi.fn(),
    regionsCreateManual: vi.fn(),
    regionsUpdate: vi.fn(),
    regionsRemove: vi.fn(),
  });

const input = {
  scopeKey: okValue(toScopeKey('owner')),
  imageId: okValue(toImageId('base')),
};

it('revalidates a fresh idle result for observers using the default mount policy', async () => {
  const regionsGet = vi
    .fn<SegmentationQueryFacade['regionsGet']>()
    .mockResolvedValue({
      regions: [],
      detection: { type: 'waiting', remainingMs: 60_000, omissions: [] },
    });
  const options = queries(regionsGet).regions(input);
  const client = new QueryClient();
  client.setQueryData(options.queryKey, {
    regions: [],
    detection: { type: 'idle', omissions: [] },
  });
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data?.detection.type).toBe('waiting')
    );
    expect(regionsGet).toHaveBeenCalledOnce();
  } finally {
    unsubscribe();
    client.clear();
  }
});

it.each(['completed', 'in flight'] as const)(
  'shares a %s idle refresh with the editor observer',
  async (timing) => {
    const idle = {
      regions: [],
      detection: { type: 'idle' as const, omissions: [] },
    };
    const pending =
      Promise.withResolvers<
        Awaited<ReturnType<SegmentationQueryFacade['regionsGet']>>
      >();
    const regionsGet = vi
      .fn<SegmentationQueryFacade['regionsGet']>()
      .mockReturnValue(pending.promise);
    const segmentation = queries(regionsGet);
    const client = new QueryClient();
    const options = segmentation.regions(input, { refreshIdleOnMount: false });
    client.setQueryData(options.queryKey, idle);
    const prefetch = segmentation.prefetchEditorRegions(client, input, true);
    if (timing === 'completed') {
      pending.resolve({
        regions: [],
        detection: { type: 'idle', omissions: [] },
      });
      await prefetch;
    }
    const unsubscribe = new QueryObserver(client, options).subscribe(() => {});
    try {
      pending.resolve({
        regions: [],
        detection: { type: 'idle', omissions: [] },
      });
      await prefetch;
      expect(regionsGet).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      client.clear();
    }
  }
);
