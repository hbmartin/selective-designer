import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';

import {
  createServerFunctionInvoker,
  type ServerFnContextRunner,
} from '@/platform/lib/tanstack-start/server-function-handler';

import type { ProtectedContext } from '@/modules/auth/backend';

import {
  createDesignHandlers,
  type DesignHandlers,
  zDesignByIdInput,
  zDesignCreateInput,
  zDesignIdInput,
  zDesignListInput,
  zDesignRenameInput,
  zSourcePhotoAddInput,
} from '../http/design-handlers';

type ProtectedRunner = ServerFnContextRunner<ProtectedContext>;

type DesignServerRuntimeDeps = {
  handlers: DesignHandlers;
  withProtectedContext: ProtectedRunner;
  withProtectedMutation: ProtectedRunner;
};

const getDeps = createServerOnlyFn(
  async (): Promise<DesignServerRuntimeDeps> => {
    const [
      { getDesignUseCases },
      { getKernel },
      { withProtectedContext, withProtectedMutation },
    ] = await Promise.all([
      import('@/composition/design'),
      import('@/composition/kernel'),
      import('@/modules/auth/backend'),
    ]);

    return {
      handlers: createDesignHandlers({
        getUseCases: (ctx) =>
          getDesignUseCases({ kernel: getKernel({ logger: ctx.logger }) }),
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

export const designGetAll = createServerFn({ method: 'GET' })
  .inputValidator(zDesignListInput())
  .handler(async ({ data }) =>
    runProtected.withOperation('design.getAll')(
      data,
      ({ handlers }, ctx, input) => handlers.getAll(ctx, input)
    )
  );

export const designGetById = createServerFn({ method: 'GET' })
  .inputValidator(zDesignByIdInput())
  .handler(async ({ data }) =>
    runProtected.withOperation('design.getById')(
      data,
      ({ handlers }, ctx, input) => handlers.getById(ctx, input)
    )
  );

export const designCreate = createServerFn({ method: 'POST' })
  .inputValidator(zDesignCreateInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('design.create')(
      data,
      ({ handlers }, ctx, input) => handlers.create(ctx, input)
    )
  );

export const designRename = createServerFn({ method: 'POST' })
  .inputValidator(zDesignRenameInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('design.rename')(
      data,
      ({ handlers }, ctx, input) => handlers.rename(ctx, input)
    )
  );

export const designArchive = createServerFn({ method: 'POST' })
  .inputValidator(zDesignByIdInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('design.archive')(
      data,
      ({ handlers }, ctx, input) => handlers.archive(ctx, input)
    )
  );

export const designUnarchive = createServerFn({ method: 'POST' })
  .inputValidator(zDesignByIdInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('design.unarchive')(
      data,
      ({ handlers }, ctx, input) => handlers.unarchive(ctx, input)
    )
  );

export const designListSourcePhotos = createServerFn({ method: 'GET' })
  .inputValidator(zDesignIdInput())
  .handler(async ({ data }) =>
    runProtected.withOperation('design.listSourcePhotos')(
      data,
      ({ handlers }, ctx, input) => handlers.listSourcePhotos(ctx, input)
    )
  );

export const designAddSourcePhoto = createServerFn({ method: 'POST' })
  .inputValidator(zSourcePhotoAddInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('design.addSourcePhoto')(
      data,
      ({ handlers }, ctx, input) => handlers.addSourcePhoto(ctx, input)
    )
  );

export type DesignServerFunctions = {
  designListSourcePhotos: typeof designListSourcePhotos;
  designAddSourcePhoto: typeof designAddSourcePhoto;
  designGetAll: typeof designGetAll;
  designGetById: typeof designGetById;
  designCreate: typeof designCreate;
  designRename: typeof designRename;
  designArchive: typeof designArchive;
  designUnarchive: typeof designUnarchive;
};
