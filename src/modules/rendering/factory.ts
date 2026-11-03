import {
  copyDraftPlacements,
  markResultFailed,
  pollResult,
  runnableResults,
  submitResult,
} from './application/use-cases/pipeline';
import {
  draftFromOriginal,
  getDraft,
  getRender,
  getRenderSource,
  getScorecard,
  listRenders,
  markPreferredResult,
  nameScheme,
  previewPlan,
  retryResult,
  saveDraft,
  submitBatch,
  submitRender,
} from './application/use-cases/renders';
import type {
  RenderingPipelineDeps,
  RenderingUseCaseDeps,
} from './application/use-cases/types';

type Input<TFn extends (deps: never, input: never) => unknown> =
  Parameters<TFn>[1];

export function createRenderingUseCases(deps: RenderingUseCaseDeps) {
  return {
    getRenderSource: (input: Input<typeof getRenderSource>) =>
      getRenderSource(deps, input),
    getDraft: (input: Input<typeof getDraft>) => getDraft(deps, input),
    saveDraft: (input: Input<typeof saveDraft>) => saveDraft(deps, input),
    previewPlan: (input: Input<typeof previewPlan>) => previewPlan(deps, input),
    submitRender: (input: Input<typeof submitRender>) =>
      submitRender(deps, input),
    submitBatch: (input: Input<typeof submitBatch>) => submitBatch(deps, input),
    listRenders: (input: Input<typeof listRenders>) => listRenders(deps, input),
    retryResult: (input: Input<typeof retryResult>) => retryResult(deps, input),
    markPreferredResult: (input: Input<typeof markPreferredResult>) =>
      markPreferredResult(deps, input),
    nameScheme: (input: Input<typeof nameScheme>) => nameScheme(deps, input),
    getRender: (input: Input<typeof getRender>) => getRender(deps, input),
    getScorecard: (input: Input<typeof getScorecard>) =>
      getScorecard(deps, input),
    draftFromOriginal: (input: Input<typeof draftFromOriginal>) =>
      draftFromOriginal(deps, input),
  };
}
export type RenderingUseCases = ReturnType<typeof createRenderingUseCases>;

export function createRenderingPipelineUseCases(deps: RenderingPipelineDeps) {
  return {
    runnable: (renderId: Input<typeof runnableResults>) =>
      runnableResults(deps, renderId),
    submit: (resultId: Input<typeof submitResult>) =>
      submitResult(deps, resultId),
    poll: (resultId: Input<typeof pollResult>) => pollResult(deps, resultId),
    markFailed: (input: Input<typeof markResultFailed>) =>
      markResultFailed(deps, input),
    copyDraftPlacements: (input: Input<typeof copyDraftPlacements>) =>
      copyDraftPlacements(deps, input),
  };
}
export type RenderingPipelineUseCases = ReturnType<
  typeof createRenderingPipelineUseCases
>;
