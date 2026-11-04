import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';

import {
  createServerFunctionInvoker,
  type ServerFnContextRunner,
} from '@/platform/lib/tanstack-start/server-function-handler';

import type { ProtectedContext } from '@/modules/auth/backend';

import {
  createUserHandlers,
  type UserHandlers,
  zDeleteByIdInput,
  zGetAllInput,
  zGetByIdInput,
  zGetUserSessionsInput,
  zRevokeUserSessionInput,
  zRevokeUserSessionsInput,
  zUpdateByIdInput,
} from '../http/user-handlers';

type ProtectedRunner = ServerFnContextRunner<ProtectedContext>;

type UserServerRuntimeDeps = {
  handlers: UserHandlers;
  withProtectedContext: ProtectedRunner;
  withFreshProtectedMutation: ProtectedRunner;
};

const getDeps = createServerOnlyFn(async (): Promise<UserServerRuntimeDeps> => {
  const [
    { getUserUseCases },
    { getKernel },
    { withProtectedContext, withFreshProtectedMutation },
  ] = await Promise.all([
    import('@/composition/user'),
    import('@/composition/kernel'),
    import('@/modules/auth/backend'),
  ]);

  return {
    handlers: createUserHandlers({
      getUseCases: (ctx) =>
        getUserUseCases({
          kernel: getKernel({ logger: ctx.logger }),
        }),
    }),
    withProtectedContext,
    withFreshProtectedMutation,
  };
});

const runProtected = createServerFunctionInvoker({
  getDeps,
  selectRunner: (deps) => deps.withProtectedContext,
});

// Destructive or privilege-granting admin actions additionally require a fresh
// session (step-up re-authentication). A stale session is rejected with
// `reauth_required`.
const runFreshMutation = createServerFunctionInvoker({
  getDeps,
  selectRunner: (deps) => deps.withFreshProtectedMutation,
});

export const userGetAll = createServerFn({ method: 'GET' })
  .validator(zGetAllInput())
  .handler(async ({ data }) =>
    runProtected.withOperation('user.getAll')(
      data,
      ({ handlers }, ctx, input) => handlers.getAll(ctx, input)
    )
  );

export const userGetById = createServerFn({ method: 'GET' })
  .validator(zGetByIdInput())
  .handler(async ({ data }) =>
    runProtected.withOperation('user.getById')(
      data,
      ({ handlers }, ctx, input) => handlers.getById(ctx, input)
    )
  );

export const userUpdateById = createServerFn({ method: 'POST' })
  .validator(zUpdateByIdInput())
  .handler(async ({ data }) =>
    runFreshMutation.withOperation('user.updateById')(
      data,
      ({ handlers }, ctx, input) => handlers.updateById(ctx, input)
    )
  );

export const userDeleteById = createServerFn({ method: 'POST' })
  .validator(zDeleteByIdInput())
  .handler(async ({ data }) =>
    runFreshMutation.withOperation('user.deleteById')(
      data,
      ({ handlers }, ctx, input) => handlers.deleteById(ctx, input)
    )
  );

export const userGetUserSessions = createServerFn({ method: 'GET' })
  .validator(zGetUserSessionsInput())
  .handler(async ({ data }) =>
    runProtected.withOperation('user.getUserSessions')(
      data,
      ({ handlers }, ctx, input) => handlers.getUserSessions(ctx, input)
    )
  );

export const userRevokeUserSessions = createServerFn({ method: 'POST' })
  .validator(zRevokeUserSessionsInput())
  .handler(async ({ data }) =>
    runFreshMutation.withOperation('user.revokeUserSessions')(
      data,
      ({ handlers }, ctx, input) => handlers.revokeUserSessions(ctx, input)
    )
  );

export const userRevokeUserSession = createServerFn({ method: 'POST' })
  .validator(zRevokeUserSessionInput())
  .handler(async ({ data }) =>
    runFreshMutation.withOperation('user.revokeUserSession')(
      data,
      ({ handlers }, ctx, input) => handlers.revokeUserSession(ctx, input)
    )
  );

export type UserServerFunctions = {
  userGetAll: typeof userGetAll;
  userGetById: typeof userGetById;
  userUpdateById: typeof userUpdateById;
  userDeleteById: typeof userDeleteById;
  userGetUserSessions: typeof userGetUserSessions;
  userRevokeUserSessions: typeof userRevokeUserSessions;
  userRevokeUserSession: typeof userRevokeUserSession;
};
