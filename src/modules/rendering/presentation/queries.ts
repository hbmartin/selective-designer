import {
  scopedEntityQueryOptions,
  type ScopedQueryInput,
  serverMutationOptions,
} from '@/platform/lib/tanstack-query/scoped-query-options';
import type { ServerFunctionFacade } from '@/platform/lib/tanstack-start/server-function-types';

import type { ImageId, ScopeKey } from '@/modules/kernel/domain/ids';

import type { RenderingServerFunctions } from '../server';

export type RenderingQueryFacade =
  ServerFunctionFacade<RenderingServerFunctions>;

export const createRenderingQueries = <TFacade extends RenderingQueryFacade>(
  facade: TFacade
) => {
  const all = () => ['rendering', 'v1'] as const;
  return {
    all,
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
    saveDraft: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'saveDraft'],
        mutationFn: facade.renderDraftSave,
      }),
    previewPlan: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'previewPlan'],
        mutationFn: facade.renderPlanPreview,
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
