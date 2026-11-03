import {
  scopedEntityQueryOptions,
  scopedListQueryOptions,
  type ScopedQueryInput,
  serverMutationOptions,
} from '@/platform/lib/tanstack-query/scoped-query-options';
import type { ServerFunctionFacade } from '@/platform/lib/tanstack-start/server-function-types';

import type { ImageId, RenderId, ScopeKey } from '@/modules/kernel/domain/ids';

import type { EditSet } from '../domain/edit-set';
import type { RenderingServerFunctions } from '../server';

export type RenderingQueryFacade =
  ServerFunctionFacade<RenderingServerFunctions>;

export const createRenderingQueries = <TFacade extends RenderingQueryFacade>(
  facade: TFacade
) => {
  const all = () => ['rendering', 'v1'] as const;
  return {
    all,
    source: (input: { imageId: ImageId } & ScopedQueryInput<ScopeKey>) => ({
      ...scopedEntityQueryOptions({
        baseKey: (scopeKey: ScopeKey) =>
          [...all(), { scopeKey }, 'source'] as const,
        input,
        queryFn: (data) => facade.renderSourceGet({ data }),
      }),
      // Signed URLs last an hour; refresh well before that.
      staleTime: 20 * 60 * 1000,
    }),
    draft: (input: { imageId: ImageId } & ScopedQueryInput<ScopeKey>) =>
      scopedEntityQueryOptions({
        baseKey: (scopeKey: ScopeKey) =>
          [...all(), { scopeKey }, 'draft'] as const,
        input,
        queryFn: (data) => facade.renderDraftGet({ data }),
      }),
    renders: (input: { imageId: ImageId } & ScopedQueryInput<ScopeKey>) =>
      scopedEntityQueryOptions({
        baseKey: (scopeKey: ScopeKey) =>
          [...all(), { scopeKey }, 'renders'] as const,
        input,
        queryFn: (data) => facade.rendersGet({ data }),
      }),
    /** Read-only preview of which models will run (POST: edit sets are large). */
    plan: (
      input: { imageId: ImageId; editSet: EditSet } & ScopedQueryInput<ScopeKey>
    ) =>
      scopedEntityQueryOptions({
        baseKey: (scopeKey: ScopeKey) =>
          [...all(), { scopeKey }, 'plan'] as const,
        input,
        queryFn: (data) => facade.renderPlanPreview({ data }),
      }),
    render: (input: { renderId: RenderId } & ScopedQueryInput<ScopeKey>) => ({
      ...scopedEntityQueryOptions({
        baseKey: (scopeKey: ScopeKey) =>
          [...all(), { scopeKey }, 'render'] as const,
        input,
        queryFn: (data) => facade.renderGet({ data }),
      }),
      staleTime: 20 * 60 * 1000,
    }),
    scorecard: (input: ScopedQueryInput<ScopeKey>) =>
      scopedListQueryOptions({
        baseKey: (scopeKey: ScopeKey) =>
          [...all(), { scopeKey }, 'scorecard'] as const,
        input,
        queryFn: () => facade.renderScorecardGet(),
      }),
    draftFromOriginal: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'draftFromOriginal'],
        mutationFn: facade.renderDraftFromOriginal,
      }),
    saveDraft: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'saveDraft'],
        mutationFn: facade.renderDraftSave,
      }),
    submit: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'submit'],
        mutationFn: facade.renderSubmit,
      }),
    submitBatch: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'submitBatch'],
        mutationFn: facade.renderSubmitBatch,
      }),
    retry: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'retry'],
        mutationFn: facade.renderResultRetry,
      }),
    prefer: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'prefer'],
        mutationFn: facade.renderResultPrefer,
      }),
    nameScheme: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'nameScheme'],
        mutationFn: facade.renderResultNameScheme,
      }),
  };
};
