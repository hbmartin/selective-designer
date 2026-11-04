import {
  createServerFn,
  createServerFn as makeServerFunction,
  createServerOnlyFn,
} from '@tanstack/react-start';
import { withProtectedMutation as directMutation } from '@/modules/auth/backend';
import { createServerFunctionInvoker } from '@/platform/lib/tanstack-start/server-function-handler';

export const unsafeMutation = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => data
);

const runMutation = async (_data: unknown, fn: () => unknown) => fn();

export const unsafeNamedMutation = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => runMutation(data, () => data)
);

export const wrapperOnlyMutation = createServerFn({ method: 'POST' }).handler(
  async () => {
    const runner = runMutation;
    return runner;
  }
);

export const currentSession = createServerFn({ method: 'GET' }).handler(
  async () => null
);

const getDeps = createServerOnlyFn(async () => {
  const [{ withProtectedMutation, withPublicContext }] = await Promise.all([
    import('@/modules/auth/backend'),
  ]);
  return { withProtectedMutation, withPublicContext };
});

const protectedMutation = createServerFunctionInvoker({
  getDeps,
  selectRunner: (deps) => deps.withProtectedMutation,
});

const publicMutation = createServerFunctionInvoker({
  getDeps,
  selectRunner: (deps) => deps.withPublicContext,
});

export const safeInstrumentedMutation = createServerFn({
  method: 'POST',
}).handler(async ({ data }) =>
  protectedMutation.withOperation('test')(data, () => data)
);

export const unusedOperation = createServerFn({ method: 'POST' }).handler(
  async () => {
    const invoke = protectedMutation.withOperation('unused');
    return invoke;
  }
);

export const unsafeInstrumentedMutation = createServerFn({
  method: 'POST',
}).handler(async ({ data }) =>
  publicMutation.withOperation('test')(data, () => data)
);

declare const chooseProtected: boolean;

const mixedBlock = createServerFunctionInvoker({
  getDeps,
  selectRunner: (deps) => {
    if (chooseProtected) return deps.withProtectedMutation;
    return deps.withPublicContext;
  },
});

const mixedConditional = createServerFunctionInvoker({
  getDeps,
  selectRunner: (deps) =>
    chooseProtected ? deps.withProtectedMutation : deps.withPublicContext,
});

export const unsafeMixedBlock = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => mixedBlock.withOperation('test')(data, () => data)
);

export const unsafeMixedConditional = createServerFn({
  method: 'POST',
}).handler(async ({ data }) =>
  mixedConditional.withOperation('test')(data, () => data)
);

let reassigned = createServerFunctionInvoker({
  getDeps,
  selectRunner: (deps) => deps.withProtectedMutation,
});
reassigned = createServerFunctionInvoker({
  getDeps,
  selectRunner: (deps) => deps.withPublicContext,
});
export const unsafeReassignment = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => reassigned.withOperation('test')(data, () => data)
);

export const unsafeMixedHandler = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => {
    if (data) return publicMutation.withOperation('test')(data, () => data);
    return protectedMutation.withOperation('test')(data, () => data);
  }
);

const spoofedDeps = createServerOnlyFn(async () => {
  const withProtectedMutation = (fn: () => unknown) => fn();
  return { withProtectedMutation };
});
const spoofed = createServerFunctionInvoker({
  getDeps: spoofedDeps,
  selectRunner: (deps) => deps.withProtectedMutation,
});
export const unsafeSpoofed = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => spoofed.withOperation('test')(data, () => data)
);

const withProtectedMutation = (fn: () => unknown) => fn();
export const unsafeDirect = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => withProtectedMutation(() => data)
);

export const safeDirect = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => {
    return await directMutation(() => data);
  }
);

function spoofFactory() {
  const createServerFunctionInvoker = (_options: unknown) => ({
    withOperation: (_operation: string) => (data: unknown) => data,
  });
  return createServerFunctionInvoker;
}
const fakeFactory = spoofFactory();
const fakeInvoker = fakeFactory({
  getDeps,
  selectRunner: (deps: Awaited<ReturnType<typeof getDeps>>) =>
    deps.withProtectedMutation,
});
export const unsafeFactory = createServerFn({ method: 'POST' }).handler(
  async ({ data }) => fakeInvoker.withOperation('test')(data)
);

export const unsafeAliasedBuilder = makeServerFunction({
  method: 'POST',
}).handler(async ({ data }) => data);
