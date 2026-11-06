import { createDesignRepository } from '@/modules/design/backend';
import { cleanupRenderOutput } from '@/modules/rendering';
import {
  createOutputCleanupStore,
  createRenderRepository,
} from '@/modules/rendering/backend';

import { getPipelineKernel } from './pipeline-kernel';
import { createResultOutputReferences } from './rendering-pipeline';
import { createCachedFactory } from './shared/singleton';

const factory = createCachedFactory(() => {
  const kernel = getPipelineKernel();
  const store = createOutputCleanupStore({ db: kernel.db });
  const deps = {
    ...kernel,
    store,
    resultOutputReferences: createResultOutputReferences(
      createDesignRepository({ db: kernel.db }),
      createRenderRepository({ db: kernel.db })
    ),
  };
  return {
    process: (cleanupId: string) => cleanupRenderOutput(deps, cleanupId),
    list: (input: { before: string; after?: string }) =>
      store.list({ ...input, before: new Date(input.before), limit: 100 }),
    startedAt: () => kernel.clock.now().toISOString(),
  };
});
export const getRenderOutputCleanup = () => factory.get();
