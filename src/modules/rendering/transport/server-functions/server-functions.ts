import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';

import {
  createServerFunctionInvoker,
  type ServerFnContextRunner,
} from '@/platform/lib/tanstack-start/server-function-handler';

import type { ProtectedContext } from '@/modules/auth/backend';

import {
  createRenderingHandlers,
  type RenderingHandlers,
  zImageInput,
  zPreferInput,
  zPreviewPlanInput,
  zRenderInput,
  zResultInput,
  zSaveDraftInput,
  zSchemeInput,
  zSubmitBatchInput,
  zSubmitRenderInput,
} from '../http/rendering-handlers';

type ProtectedRunner = ServerFnContextRunner<ProtectedContext>;

const getDeps = createServerOnlyFn(
  async (): Promise<{
    handlers: RenderingHandlers;
    withProtectedContext: ProtectedRunner;
    withProtectedMutation: ProtectedRunner;
  }> => {
    const [
      { getRenderingUseCases },
      { getKernel },
      { withProtectedContext, withProtectedMutation },
    ] = await Promise.all([
      import('@/composition/rendering'),
      import('@/composition/kernel'),
      import('@/modules/auth/backend'),
    ]);
    return {
      handlers: createRenderingHandlers({
        getUseCases: (ctx) =>
          getRenderingUseCases({ kernel: getKernel({ logger: ctx.logger }) }),
      }),
      withProtectedContext,
      withProtectedMutation,
    };
  }
);

const runProtected = createServerFunctionInvoker({
  getDeps,
  selectRunner: (deps) => deps.withProtectedContext,
});
const runMutation = createServerFunctionInvoker({
  getDeps,
  selectRunner: (deps) => deps.withProtectedMutation,
});

export const renderSourceGet = createServerFn({ method: 'GET' })
  .validator(zImageInput())
  .handler(async ({ data }) =>
    runProtected.withOperation('rendering.sourceGet')(
      data,
      ({ handlers }, ctx, input) => handlers.getRenderSource(ctx, input)
    )
  );

export const renderDraftGet = createServerFn({ method: 'GET' })
  .validator(zImageInput())
  .handler(async ({ data }) =>
    runProtected.withOperation('rendering.draftGet')(
      data,
      ({ handlers }, ctx, input) => handlers.getDraft(ctx, input)
    )
  );

export const renderDraftSave = createServerFn({ method: 'POST' })
  .validator(zSaveDraftInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('rendering.draftSave')(
      data,
      ({ handlers }, ctx, input) => handlers.saveDraft(ctx, input)
    )
  );

/**
 * Read-only, but POST (the edit set can be larger than a query string), so it
 * runs with the mutation runner's request checks.
 */
export const renderPlanPreview = createServerFn({ method: 'POST' })
  .validator(zPreviewPlanInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('rendering.planPreview')(
      data,
      ({ handlers }, ctx, input) => handlers.previewPlan(ctx, input)
    )
  );

export const renderSubmit = createServerFn({ method: 'POST' })
  .validator(zSubmitRenderInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('rendering.submit')(
      data,
      ({ handlers }, ctx, input) => handlers.submitRender(ctx, input)
    )
  );

export const renderSubmitBatch = createServerFn({ method: 'POST' })
  .validator(zSubmitBatchInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('rendering.submitBatch')(
      data,
      ({ handlers }, ctx, input) => handlers.submitBatch(ctx, input)
    )
  );

export const rendersGet = createServerFn({ method: 'GET' })
  .validator(zImageInput())
  .handler(async ({ data }) =>
    runProtected.withOperation('rendering.list')(
      data,
      ({ handlers }, ctx, input) => handlers.listRenders(ctx, input)
    )
  );

export const renderResultRetry = createServerFn({ method: 'POST' })
  .validator(zResultInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('rendering.retry')(
      data,
      ({ handlers }, ctx, input) => handlers.retryResult(ctx, input)
    )
  );

export const renderResultPrefer = createServerFn({ method: 'POST' })
  .validator(zPreferInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('rendering.prefer')(
      data,
      ({ handlers }, ctx, input) => handlers.markPreferred(ctx, input)
    )
  );

export const renderResultNameScheme = createServerFn({ method: 'POST' })
  .validator(zSchemeInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('rendering.nameScheme')(
      data,
      ({ handlers }, ctx, input) => handlers.nameScheme(ctx, input)
    )
  );

export const renderGet = createServerFn({ method: 'GET' })
  .validator(zRenderInput())
  .handler(async ({ data }) =>
    runProtected.withOperation('rendering.get')(
      data,
      ({ handlers }, ctx, input) => handlers.getRender(ctx, input)
    )
  );

export const renderScorecardGet = createServerFn({ method: 'GET' }).handler(
  async () =>
    runProtected.withOperation('rendering.scorecard')(
      undefined,
      ({ handlers }, ctx) => handlers.getScorecard(ctx)
    )
);

export const renderDraftFromOriginal = createServerFn({ method: 'POST' })
  .validator(zRenderInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('rendering.draftFromOriginal')(
      data,
      ({ handlers }, ctx, input) => handlers.draftFromOriginal(ctx, input)
    )
  );

export type RenderingServerFunctions = {
  renderGet: typeof renderGet;
  renderScorecardGet: typeof renderScorecardGet;
  renderDraftFromOriginal: typeof renderDraftFromOriginal;
  renderSourceGet: typeof renderSourceGet;
  renderDraftGet: typeof renderDraftGet;
  renderDraftSave: typeof renderDraftSave;
  renderPlanPreview: typeof renderPlanPreview;
  renderSubmit: typeof renderSubmit;
  renderSubmitBatch: typeof renderSubmitBatch;
  rendersGet: typeof rendersGet;
  renderResultRetry: typeof renderResultRetry;
  renderResultPrefer: typeof renderResultPrefer;
  renderResultNameScheme: typeof renderResultNameScheme;
};
