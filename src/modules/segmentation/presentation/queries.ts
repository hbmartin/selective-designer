import { replaceEqualDeep } from '@tanstack/react-query';

import {
  scopedEntityQueryOptions,
  type ScopedQueryInput,
  serverMutationOptions,
} from '@/platform/lib/tanstack-query/scoped-query-options';
import type { ServerFunctionFacade } from '@/platform/lib/tanstack-start/server-function-types';

import type { ImageId, ScopeKey } from '@/modules/kernel/domain/ids';

import type { RegionListView } from '../application/use-cases/regions';
import {
  DETECTION_LEASE_MS,
  SIGNED_MASK_URL_SECONDS,
} from '../application/use-cases/types';
import type { SegmentationServerFunctions } from '../server';

const shareRegionMasks = (previous: unknown, next: RegionListView) => {
  const cached = previous as RegionListView | undefined;
  if (!cached) return next;
  const regionsById = new Map(
    cached.regions.map((region) => [region.id, region])
  );
  const regions = next.regions.map((region) => {
    const existing = regionsById.get(region.id);
    const refreshBy =
      region.maskUrlExpiresAt - SIGNED_MASK_URL_SECONDS * 1000 + 60_000;
    return existing?.maskKey === region.maskKey &&
      existing.maskUrlExpiresAt > refreshBy
      ? {
          ...region,
          maskUrl: existing.maskUrl,
          maskUrlExpiresAt: existing.maskUrlExpiresAt,
        }
      : region;
  });
  return replaceEqualDeep(cached, { ...next, regions });
};

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
      staleTime: 5000,
      structuralSharing: (previous: unknown, next: unknown) =>
        shareRegionMasks(previous, next as RegionListView),
      refetchInterval: (query: {
        state: { data: RegionListView | undefined };
      }) => {
        const data = query.state.data;
        if (data?.detection !== 'pending') return false;
        return DETECTION_LEASE_MS - data.detectionRemainingMs < 60_000
          ? 3000
          : 15_000;
      },
    }),
    retryDetection: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'retryDetection'],
        mutationFn: facade.regionsRetryDetection,
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
