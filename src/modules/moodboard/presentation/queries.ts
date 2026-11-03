import {
  scopedEntityQueryOptions,
  scopedListQueryOptions,
  type ScopedQueryInput,
  serverMutationOptions,
} from '@/platform/lib/tanstack-query/scoped-query-options';
import type { ServerFunctionFacade } from '@/platform/lib/tanstack-start/server-function-types';

import type { DesignId, ScopeKey } from '@/modules/kernel/domain/ids';

import type { MoodboardServerFunctions } from '../server';

export type MoodboardQueryFacade =
  ServerFunctionFacade<MoodboardServerFunctions>;

const version = 'v1';
/** Item payloads carry signed URLs valid for an hour. */
export const MOODBOARD_STALE_TIME_MS = 20 * 60 * 1000;

export const createMoodboardQueries = <TFacade extends MoodboardQueryFacade>(
  facade: TFacade
) => {
  const all = () => ['moodboard', version] as const;
  return {
    all,
    byDesign: (input: { designId: DesignId } & ScopedQueryInput<ScopeKey>) => ({
      ...scopedEntityQueryOptions({
        baseKey: (scopeKey: ScopeKey) =>
          [...all(), { scopeKey }, 'byDesign'] as const,
        input,
        queryFn: (data) => facade.moodboardGet({ data }),
      }),
      staleTime: MOODBOARD_STALE_TIME_MS,
    }),
    categories: (input: ScopedQueryInput<ScopeKey>) =>
      scopedListQueryOptions({
        baseKey: (scopeKey: ScopeKey) =>
          [...all(), { scopeKey }, 'categories'] as const,
        input,
        queryFn: () => facade.moodboardCategories(),
      }),
    createItem: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'createItem'],
        mutationFn: facade.moodboardItemCreate,
      }),
    updateItem: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'updateItem'],
        mutationFn: facade.moodboardItemUpdate,
      }),
    removeItem: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'removeItem'],
        mutationFn: facade.moodboardItemRemove,
      }),
    correctCutout: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'correctCutout'],
        mutationFn: facade.moodboardCutoutCorrect,
      }),
    retryCutout: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'retryCutout'],
        mutationFn: facade.moodboardCutoutRetry,
      }),
  };
};
