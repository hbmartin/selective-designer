import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';

import {
  createServerFunctionInvoker,
  type ServerFnContextRunner,
} from '@/platform/lib/tanstack-start/server-function-handler';

import type { ProtectedContext } from '@/modules/auth/backend';

import {
  createMoodboardHandlers,
  type MoodboardHandlers,
  zCutoutCorrectionInput,
  zItemCreateInput,
  zItemIdInput,
  zItemUpdateInput,
  zMoodboardInput,
} from '../http/moodboard-handlers';

type ProtectedRunner = ServerFnContextRunner<ProtectedContext>;

const getDeps = createServerOnlyFn(
  async (): Promise<{
    handlers: MoodboardHandlers;
    withProtectedContext: ProtectedRunner;
    withProtectedMutation: ProtectedRunner;
  }> => {
    const [
      { getMoodboardUseCases },
      { getKernel },
      { withProtectedContext, withProtectedMutation },
    ] = await Promise.all([
      import('@/composition/moodboard'),
      import('@/composition/kernel'),
      import('@/modules/auth/backend'),
    ]);
    return {
      handlers: createMoodboardHandlers({
        getUseCases: (ctx) =>
          getMoodboardUseCases({ kernel: getKernel({ logger: ctx.logger }) }),
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

export const moodboardGet = createServerFn({ method: 'GET' })
  .validator(zMoodboardInput())
  .handler(async ({ data }) =>
    runProtected.withOperation('moodboard.get')(
      data,
      ({ handlers }, ctx, input) => handlers.list(ctx, input)
    )
  );

export const moodboardCategories = createServerFn({ method: 'GET' }).handler(
  async () =>
    runProtected.withOperation('moodboard.categories')(
      undefined,
      ({ handlers }, ctx) => handlers.categories(ctx)
    )
);

export const moodboardItemCreate = createServerFn({ method: 'POST' })
  .validator(zItemCreateInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('moodboard.itemCreate')(
      data,
      ({ handlers }, ctx, input) => handlers.create(ctx, input)
    )
  );

export const moodboardItemUpdate = createServerFn({ method: 'POST' })
  .validator(zItemUpdateInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('moodboard.itemUpdate')(
      data,
      ({ handlers }, ctx, input) => handlers.update(ctx, input)
    )
  );

export const moodboardItemRemove = createServerFn({ method: 'POST' })
  .validator(zItemIdInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('moodboard.itemRemove')(
      data,
      ({ handlers }, ctx, input) => handlers.remove(ctx, input)
    )
  );

export const moodboardCutoutCorrect = createServerFn({ method: 'POST' })
  .validator(zCutoutCorrectionInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('moodboard.cutoutCorrect')(
      data,
      ({ handlers }, ctx, input) => handlers.correctCutout(ctx, input)
    )
  );

export const moodboardCutoutRetry = createServerFn({ method: 'POST' })
  .validator(zItemIdInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('moodboard.cutoutRetry')(
      data,
      ({ handlers }, ctx, input) => handlers.retryCutout(ctx, input)
    )
  );

export type MoodboardServerFunctions = {
  moodboardGet: typeof moodboardGet;
  moodboardCategories: typeof moodboardCategories;
  moodboardItemCreate: typeof moodboardItemCreate;
  moodboardItemUpdate: typeof moodboardItemUpdate;
  moodboardItemRemove: typeof moodboardItemRemove;
  moodboardCutoutCorrect: typeof moodboardCutoutCorrect;
  moodboardCutoutRetry: typeof moodboardCutoutRetry;
};
