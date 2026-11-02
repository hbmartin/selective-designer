import { describe, expect, it, vi } from 'vitest';

// Make `createServerFn().inputValidator(...).handler(fn)` resolve to the inner
// handler so we can invoke each server function directly in a unit test.
vi.mock('@tanstack/react-start', () => {
  const builder = {
    inputValidator: () => builder,
    handler: (fn: unknown) => fn,
  };
  return {
    createServerFn: () => builder,
    createServerOnlyFn: (fn: unknown) => fn,
  };
});

// Replace the invoker so that calling a server function resolves to a tag that
// identifies which runner its `selectRunner` chose against tagged deps.
vi.mock('@/platform/lib/tanstack-start/server-function-handler', () => {
  const taggedDeps = {
    handlers: {},
    withProtectedContext: 'protected',
    withProtectedMutation: 'mutation',
    withFreshProtectedMutation: 'fresh',
  };
  return {
    createServerFunctionInvoker: ({
      selectRunner,
    }: {
      selectRunner: (deps: typeof taggedDeps) => unknown;
    }) => {
      const invoke = () => Promise.resolve(selectRunner(taggedDeps));
      return Object.assign(invoke, { withOperation: () => invoke });
    },
  };
});

const loadServerFunctions = () => import('@/modules/user/server');

describe('user server functions runner wiring', () => {
  it('runs destructive and privilege-granting actions through the fresh (step-up) mutation runner', async () => {
    const fns = await loadServerFunctions();

    await expect(
      (fns.userDeleteById as ExplicitAny)({ data: {} })
    ).resolves.toBe('fresh');
    await expect(
      (fns.userUpdateById as ExplicitAny)({ data: {} })
    ).resolves.toBe('fresh');
    await expect(
      (fns.userRevokeUserSessions as ExplicitAny)({ data: {} })
    ).resolves.toBe('fresh');
    await expect(
      (fns.userRevokeUserSession as ExplicitAny)({ data: {} })
    ).resolves.toBe('fresh');
    // Creating a user can mint an admin (with `user:set-role`), so it requires
    // a fresh session for parity with the other destructive admin mutations.
    await expect((fns.userCreate as ExplicitAny)({ data: {} })).resolves.toBe(
      'fresh'
    );
  });

  it('runs reads on the protected (non-step-up) runner', async () => {
    const fns = await loadServerFunctions();

    await expect((fns.userGetAll as ExplicitAny)({ data: {} })).resolves.toBe(
      'protected'
    );
    await expect((fns.userGetById as ExplicitAny)({ data: {} })).resolves.toBe(
      'protected'
    );
  });
});
