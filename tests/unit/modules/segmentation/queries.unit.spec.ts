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

it('revalidates a fresh idle result when the editor mounts', async () => {
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
