import {
  bindUseCases,
  type UseCaseScope,
} from '@/modules/kernel/application/bind-use-cases';

import { copyItems } from './application/use-cases/copy-items';
import {
  correctCutout,
  createItem,
  listMoodboard,
  removeItem,
  retryCutout,
  suggestCategories,
  updateItem,
} from './application/use-cases/manage-items';
import {
  markCutoutFailed,
  removeBackgroundForVersion,
} from './application/use-cases/remove-background';
import type {
  MoodboardPipelineDeps,
  MoodboardUseCaseDeps,
} from './application/use-cases/types';

type Input<TFn extends (deps: never, input: never) => unknown> =
  Parameters<TFn>[1];

export function createMoodboardUseCases(deps: MoodboardUseCaseDeps) {
  return {
    copyItems: (input: Input<typeof copyItems>) => copyItems(deps, input),
    list: (input: Input<typeof listMoodboard>) => listMoodboard(deps, input),
    createItem: (input: Input<typeof createItem>) => createItem(deps, input),
    updateItem: (input: Input<typeof updateItem>) => updateItem(deps, input),
    removeItem: (input: Input<typeof removeItem>) => removeItem(deps, input),
    correctCutout: (input: Input<typeof correctCutout>) =>
      correctCutout(deps, input),
    retryCutout: (input: Input<typeof retryCutout>) => retryCutout(deps, input),
    suggestCategories: (input: Input<typeof suggestCategories>) =>
      suggestCategories(deps, input),
  };
}

export type MoodboardUseCases = ReturnType<typeof createMoodboardUseCases>;

export function createMoodboardPipelineUseCases(
  deps: MoodboardPipelineDeps,
  scope?: UseCaseScope<MoodboardPipelineDeps>
) {
  return bindUseCases(
    deps,
    { removeBackground: removeBackgroundForVersion, markCutoutFailed },
    scope
  );
}

export type MoodboardPipelineUseCases = ReturnType<
  typeof createMoodboardPipelineUseCases
>;
