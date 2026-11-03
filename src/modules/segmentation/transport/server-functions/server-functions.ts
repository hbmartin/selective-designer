import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';

import {
  createServerFunctionInvoker,
  type ServerFnContextRunner,
} from '@/platform/lib/tanstack-start/server-function-handler';

import type { ProtectedContext } from '@/modules/auth/backend';

import {
  createSegmentationHandlers,
  type SegmentationHandlers,
  zManualRegionInput,
  zRegionIdInput,
  zRegionsInput,
  zRegionUpdateInput,
  zSegmentInput,
} from '../http/segmentation-handlers';

type ProtectedRunner = ServerFnContextRunner<ProtectedContext>;

const getDeps = createServerOnlyFn(
  async (): Promise<{
    handlers: SegmentationHandlers;
    withProtectedContext: ProtectedRunner;
    withProtectedMutation: ProtectedRunner;
  }> => {
    const [
      { getSegmentationUseCases },
      { getKernel },
      { withProtectedContext, withProtectedMutation },
    ] = await Promise.all([
      import('@/composition/segmentation'),
      import('@/composition/kernel'),
      import('@/modules/auth/backend'),
    ]);
    return {
      handlers: createSegmentationHandlers({
        getUseCases: (ctx) =>
          getSegmentationUseCases({
            kernel: getKernel({ logger: ctx.logger }),
          }),
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

export const regionsGet = createServerFn({ method: 'GET' })
  .inputValidator(zRegionsInput())
  .handler(async ({ data }) =>
    runProtected.withOperation('segmentation.regions')(
      data,
      ({ handlers }, ctx, input) => handlers.list(ctx, input)
    )
  );

export const regionsSegment = createServerFn({ method: 'POST' })
  .inputValidator(zSegmentInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('segmentation.segment')(
      data,
      ({ handlers }, ctx, input) => handlers.segment(ctx, input)
    )
  );

export const regionsCreateManual = createServerFn({ method: 'POST' })
  .inputValidator(zManualRegionInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('segmentation.createManual')(
      data,
      ({ handlers }, ctx, input) => handlers.createManual(ctx, input)
    )
  );

export const regionsUpdate = createServerFn({ method: 'POST' })
  .inputValidator(zRegionUpdateInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('segmentation.update')(
      data,
      ({ handlers }, ctx, input) => handlers.update(ctx, input)
    )
  );

export const regionsRemove = createServerFn({ method: 'POST' })
  .inputValidator(zRegionIdInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('segmentation.remove')(
      data,
      ({ handlers }, ctx, input) => handlers.remove(ctx, input)
    )
  );

export type SegmentationServerFunctions = {
  regionsGet: typeof regionsGet;
  regionsSegment: typeof regionsSegment;
  regionsCreateManual: typeof regionsCreateManual;
  regionsUpdate: typeof regionsUpdate;
  regionsRemove: typeof regionsRemove;
};
