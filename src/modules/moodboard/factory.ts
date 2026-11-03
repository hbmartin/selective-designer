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

export function createMoodboardPipelineUseCases(deps: MoodboardPipelineDeps) {
  return {
    removeBackground: (versionId: Input<typeof removeBackgroundForVersion>) =>
      removeBackgroundForVersion(deps, versionId),
    markCutoutFailed: (versionId: Input<typeof markCutoutFailed>) =>
      markCutoutFailed(deps, versionId),
  };
}

export type MoodboardPipelineUseCases = ReturnType<
  typeof createMoodboardPipelineUseCases
>;
