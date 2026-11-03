import {
  scopedEntityQueryOptions,
  type ScopedQueryInput,
  serverMutationOptions,
} from '@/platform/lib/tanstack-query/scoped-query-options';
import type { ServerFunctionFacade } from '@/platform/lib/tanstack-start/server-function-types';

import type { ImageId, ScopeKey } from '@/modules/kernel/domain/ids';

import type { SegmentationServerFunctions } from '../server';

export type SegmentationQueryFacade =
  ServerFunctionFacade<SegmentationServerFunctions>;

export const createSegmentationQueries = <
  TFacade extends SegmentationQueryFacade,
>(
  facade: TFacade
) => {
  const all = () => ['segmentation', 'v1'] as const;
  return {
    all,
    regions: (input: { imageId: ImageId } & ScopedQueryInput<ScopeKey>) => ({
      ...scopedEntityQueryOptions({
        baseKey: (scopeKey: ScopeKey) =>
          [...all(), { scopeKey }, 'regions'] as const,
        input,
        queryFn: (data) => facade.regionsGet({ data }),
      }),
      // Refetch on mount to pick up a run scheduled since the cached snapshot.
      staleTime: 0,
      refetchInterval: (query: {
        state: { data: { detection: 'pending' | 'idle' } | undefined };
      }) => (query.state.data?.detection === 'pending' ? 3000 : false),
    }),
    segment: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'segment'],
        mutationFn: facade.regionsSegment,
      }),
    createManual: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'createManual'],
        mutationFn: facade.regionsCreateManual,
      }),
    update: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'update'],
        mutationFn: facade.regionsUpdate,
      }),
    remove: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'remove'],
        mutationFn: facade.regionsRemove,
      }),
  };
};
