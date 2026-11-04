import { createServerFn } from '@tanstack/react-start';
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

declare const getDeps: () => {
  withProtectedMutation: (fn: () => unknown) => unknown;
  withPublicContext: (fn: () => unknown) => unknown;
};

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
