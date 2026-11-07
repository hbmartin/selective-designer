import { Result } from '@bloodyowl/boxed';

import {
  type BatchId,
  type DesignId,
  type ImageId,
  type ParseResult,
  type RenderId,
  type RenderResultId,
  toBatchId,
  toRenderId,
  toRenderResultId,
  type UserId,
} from '@/modules/kernel/domain/ids';

import { type RecipeProblem, resolveRecipe } from './resolve-recipe';
import {
  type ImageNotFound,
  type RenderingForbidden,
  type RenderingResult,
  type RenderingUseCaseDeps,
  SIGNED_VIEW_URL_SECONDS,
} from './types';
import type { NewRenderResult, SourceImage } from '../ports/ports';
import {
  type Edit,
  type EditSet,
  MAX_EDITS,
  PROMPT_MAX_LENGTH,
} from '../../domain/edit-set';
import { enabledModels } from '../../domain/model-catalog';
import type { RenderRecipe } from '../../domain/recipe';
import type { Draft, Render, RenderResult } from '../../domain/render';
import { planRender, type RenderPlan } from '../../domain/render-plan';
import {
  isRenderRetryable,
  renderRetryCutoff,
} from '../../domain/render-retry-policy';

// ---- Access -------------------------------------------------------------

const loadOwnedSource = async (
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId; imageId: ImageId; action: 'read' | 'update' }
): Promise<
  RenderingResult<
    { type: 'ok'; source: SourceImage } | RenderingForbidden | ImageNotFound
  >
> => {
  const permission = await deps.permissionChecker.hasPermission(
    input.currentUserId,
    {
      design: [input.action],
    }
  );
  if (permission.isError()) return Result.Error(permission.getError());
  if (permission.get().type === 'permission_denied') {
    return Result.Ok({ type: 'rendering_forbidden' });
  }
  const found = await deps.renderInputs.sourceImage(input.imageId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (
    outcome.type === 'missing' ||
    outcome.image.ownerId !== input.currentUserId
  ) {
    return Result.Ok({ type: 'image_not_found' });
  }
  return Result.Ok({ type: 'ok', source: outcome.image });
};

const newId = <T>(
  deps: RenderingUseCaseDeps,
  parse: (value: string) => ParseResult<T>
): RenderingResult<T> => {
  const raw = deps.idGenerator.createId();
  if (raw.isError()) return Result.Error(raw.getError());
  const parsed = parse(raw.get());
  if (parsed.isError()) return Result.Error(parsed.getError());
  return Result.Ok(parsed.get());
};

// ---- Render sources ------------------------------------------------------

export type RenderSourceView = {
  imageId: ImageId;
  designId: DesignId;
  url: string;
  width: number;
  height: number;
};

export type RenderSourceOutcome =
  | { type: 'render_source'; source: RenderSourceView }
  | RenderingForbidden
  | ImageNotFound;

/** The image an editor works on (base image or a render result), signed. */
export async function getRenderSource(
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId; imageId: ImageId }
): Promise<RenderingResult<RenderSourceOutcome>> {
  const owned = await loadOwnedSource(deps, { ...input, action: 'read' });
  if (owned.isError()) return Result.Error(owned.getError());
  const outcome = owned.get();
  if (outcome.type !== 'ok') return Result.Ok(outcome);
  const signed = await deps.objectStorage.createSignedReadUrl({
    objectKey: outcome.source.workingKey,
    expiresInSeconds: SIGNED_VIEW_URL_SECONDS,
  });
  if (signed.isError()) return Result.Error(signed.getError());
  const { imageId, designId, width, height } = outcome.source;
  return Result.Ok({
    type: 'render_source',
    source: { imageId, designId, url: signed.get().url, width, height },
  });
}

// ---- Drafts -------------------------------------------------------------

const emptyDraft = (source: SourceImage, now: Date): Draft => ({
  designId: source.designId,
  renderSourceImageId: source.imageId,
  editSet: { edits: [], prompt: '' },
  revision: 0,
  updatedAt: now,
});

export type DraftOutcome =
  | { type: 'draft'; draft: Draft }
  | RenderingForbidden
  | ImageNotFound;

export async function getDraft(
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId; imageId: ImageId }
): Promise<RenderingResult<DraftOutcome>> {
  const owned = await loadOwnedSource(deps, { ...input, action: 'read' });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);
  const found = await deps.renderRepository.findDraft(input.imageId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  return Result.Ok({
    type: 'draft',
    draft:
      outcome.type === 'draft_found'
        ? outcome.draft
        : emptyDraft(ownedOutcome.source, deps.clock.now()),
  });
}

export type SaveDraftOutcome =
  | { type: 'draft_saved'; draft: Draft }
  | { type: 'draft_conflict'; draft: Draft }
  | RenderingForbidden
  | ImageNotFound;

/** Autosave; `revision` must match the stored draft (optimistic concurrency). */
export async function saveDraft(
  deps: RenderingUseCaseDeps,
  input: {
    currentUserId: UserId;
    imageId: ImageId;
    editSet: EditSet;
    revision: number;
  }
): Promise<RenderingResult<SaveDraftOutcome>> {
  const owned = await loadOwnedSource(deps, { ...input, action: 'update' });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);
  return deps.renderRepository.saveDraft({
    designId: ownedOutcome.source.designId,
    renderSourceImageId: input.imageId,
    editSet: input.editSet,
    expectedRevision: input.revision,
  });
}

// ---- Plan and submit ----------------------------------------------------

export type PlanOutcome =
  | { type: 'render_plan'; plan: RenderPlan }
  | RecipeProblem
  | RenderingForbidden
  | ImageNotFound;

const loadRecipe = async (
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId; imageId: ImageId; editSet?: EditSet }
): Promise<
  RenderingResult<
    | { type: 'recipe'; recipe: RenderRecipe; source: SourceImage }
    | RecipeProblem
    | RenderingForbidden
    | ImageNotFound
  >
> => {
  const owned = await loadOwnedSource(deps, { ...input, action: 'update' });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);
  let editSet = input.editSet;
  if (!editSet) {
    const draft = await deps.renderRepository.findDraft(input.imageId);
    if (draft.isError()) return Result.Error(draft.getError());
    const draftOutcome = draft.get();
    editSet =
      draftOutcome.type === 'draft_found'
        ? draftOutcome.draft.editSet
        : { edits: [], prompt: '' };
  }
  const recipe = await resolveRecipe(deps, {
    source: ownedOutcome.source,
    editSet,
  });
  if (recipe.isError()) return Result.Error(recipe.getError());
  const recipeOutcome = recipe.get();
  if (recipeOutcome.type !== 'recipe') return Result.Ok(recipeOutcome);
  return Result.Ok({
    type: 'recipe',
    recipe: recipeOutcome.recipe,
    source: ownedOutcome.source,
  });
};

/** Which models will run for the current draft, plus small-item warnings. */
export async function previewPlan(
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId; imageId: ImageId; editSet: EditSet }
): Promise<RenderingResult<PlanOutcome>> {
  const owned = await loadOwnedSource(deps, { ...input, action: 'read' });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);
  // Planning needs only shapes and references, not a composed mask.
  const planRecipe = {
    source: ownedOutcome.source,
    editMaskKey: input.editSet.edits.length > 0 ? 'pending' : null,
    edits: [] as RenderRecipe['edits'],
  };
  for (const edit of input.editSet.edits) {
    if (
      edit.kind === 'placement' ||
      edit.kind === 'replacement' ||
      (edit.kind === 'material' && edit.swatchItemId)
    ) {
      const itemId =
        edit.kind === 'material' ? (edit.swatchItemId as string) : edit.itemId;
      // oxlint-disable-next-line no-await-in-loop -- a handful of edits.
      const item = await deps.renderInputs.item(itemId);
      if (item.isError()) return Result.Error(item.getError());
      const itemOutcome = item.get();
      if (itemOutcome.type === 'missing')
        return Result.Ok({ type: 'item_missing', editId: edit.id });
      const recipeItem = {
        itemId,
        itemVersionId: itemOutcome.item.itemVersionId,
        name: itemOutcome.item.name,
        kind: itemOutcome.item.kind,
        referenceKey: itemOutcome.item.referenceKey ?? '',
      };
      const region = {
        regionId: '',
        label: '',
        maskKey: '',
        box: { x: 0, y: 0, width: 1, height: 1 },
      };
      planRecipe.edits.push(
        edit.kind === 'placement'
          ? {
              kind: 'placement',
              id: edit.id,
              item: recipeItem,
              box: edit.box,
              rotationDeg: edit.rotationDeg,
              note: '',
            }
          : edit.kind === 'replacement'
            ? {
                kind: 'replacement',
                id: edit.id,
                item: recipeItem,
                region,
                note: '',
              }
            : {
                kind: 'material',
                id: edit.id,
                region,
                swatch: recipeItem,
                text: '',
              }
      );
    }
  }
  return Result.Ok({
    type: 'render_plan',
    plan: planRender(planRecipe, enabledModels(deps.enabledModelIds)),
  });
}

export type SubmitOutcome =
  | { type: 'render_submitted'; renderIds: RenderId[] }
  | { type: 'draft_out_of_date' }
  | { type: 'no_models_can_render' }
  | RecipeProblem
  | RenderingForbidden
  | ImageNotFound;

const createAndSchedule = async (
  deps: RenderingUseCaseDeps,
  input: {
    source: SourceImage;
    recipe: RenderRecipe;
    batchId: BatchId | null;
    batchOptionItemId: string | null;
  }
): Promise<
  RenderingResult<
    { type: 'created'; renderId: RenderId } | { type: 'no_models_can_render' }
  >
> => {
  const plan = planRender(input.recipe, enabledModels(deps.enabledModelIds));
  if (!plan.models.some((model) => model.decision === 'include')) {
    return Result.Ok({ type: 'no_models_can_render' });
  }
  const results: NewRenderResult[] = [];
  for (const model of plan.models) {
    const id = newId(deps, toRenderResultId);
    if (id.isError()) return Result.Error(id.getError());
    results.push({
      id: id.get(),
      modelId: model.modelId,
      status: model.decision === 'include' ? 'pending' : 'skipped',
      skipReason:
        model.decision === 'skip'
          ? `${model.reason}:${model.references}/${model.limit}`
          : null,
    });
  }
  const renderId = newId(deps, toRenderId);
  if (renderId.isError()) return Result.Error(renderId.getError());
  const created = await deps.renderRepository.createRender({
    id: renderId.get(),
    designId: input.source.designId,
    renderSourceImageId: input.source.imageId,
    batchId: input.batchId,
    batchOptionItemId: input.batchOptionItemId,
    recipe: input.recipe,
    results,
    attemptStartedAt: deps.clock.now(),
  });
  if (created.isError()) return Result.Error(created.getError());
  const scheduled = await deps.renderScheduler.scheduleRender({
    renderId: renderId.get(),
    attempts: created
      .get()
      .render.results.filter((r) => r.status === 'pending')
      .map((r) => ({ resultId: r.id, attempt: r.attempt })),
  });
  if (scheduled.isError()) return Result.Error(scheduled.getError());
  deps.logger.info({
    event: 'rendering.render.submitted',
    details: { renderId: renderId.get(), models: results.length },
  });
  return Result.Ok({ type: 'created', renderId: renderId.get() });
};

/**
 * Snapshot the draft into an immutable recipe and fan out to every enabled
 * model. `revision` guards against submitting a stale draft.
 */
export async function submitRender(
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId; imageId: ImageId; revision: number }
): Promise<RenderingResult<SubmitOutcome>> {
  const draft = await deps.renderRepository.findDraft(input.imageId);
  if (draft.isError()) return Result.Error(draft.getError());
  const draftOutcome = draft.get();
  const currentRevision =
    draftOutcome.type === 'draft_found' ? draftOutcome.draft.revision : 0;
  if (currentRevision !== input.revision)
    return Result.Ok({ type: 'draft_out_of_date' });

  const recipe = await loadRecipe(deps, input);
  if (recipe.isError()) return Result.Error(recipe.getError());
  const recipeOutcome = recipe.get();
  if (recipeOutcome.type !== 'recipe') return Result.Ok(recipeOutcome);
  const created = await createAndSchedule(deps, {
    source: recipeOutcome.source,
    recipe: recipeOutcome.recipe,
    batchId: null,
    batchOptionItemId: null,
  });
  if (created.isError()) return Result.Error(created.getError());
  const createdOutcome = created.get();
  if (createdOutcome.type !== 'created') return Result.Ok(createdOutcome);
  return Result.Ok({
    type: 'render_submitted',
    renderIds: [createdOutcome.renderId],
  });
}

/**
 * A batch: one render per item option for one placement edit; every other
 * edit stays the same.
 */
export async function submitBatch(
  deps: RenderingUseCaseDeps,
  input: {
    currentUserId: UserId;
    imageId: ImageId;
    revision: number;
    placementEditId: string;
    optionItemIds: string[];
  }
): Promise<RenderingResult<SubmitOutcome>> {
  const draft = await deps.renderRepository.findDraft(input.imageId);
  if (draft.isError()) return Result.Error(draft.getError());
  const draftOutcome = draft.get();
  if (
    draftOutcome.type !== 'draft_found' ||
    draftOutcome.draft.revision !== input.revision
  ) {
    return Result.Ok({ type: 'draft_out_of_date' });
  }
  const batchId = newId(deps, toBatchId);
  if (batchId.isError()) return Result.Error(batchId.getError());

  const renderIds: RenderId[] = [];
  for (const itemId of input.optionItemIds) {
    const editSet: EditSet = {
      ...draftOutcome.draft.editSet,
      edits: draftOutcome.draft.editSet.edits.map((edit) =>
        edit.id === input.placementEditId && edit.kind === 'placement'
          ? { ...edit, itemId }
          : edit
      ),
    };
    // oxlint-disable-next-line no-await-in-loop -- options are few and ordered.
    const recipe = await loadRecipe(deps, { ...input, editSet });
    if (recipe.isError()) return Result.Error(recipe.getError());
    const recipeOutcome = recipe.get();
    if (recipeOutcome.type !== 'recipe') return Result.Ok(recipeOutcome);
    // oxlint-disable-next-line no-await-in-loop -- see above.
    const created = await createAndSchedule(deps, {
      source: recipeOutcome.source,
      recipe: recipeOutcome.recipe,
      batchId: batchId.get(),
      batchOptionItemId: itemId,
    });
    if (created.isError()) return Result.Error(created.getError());
    const createdOutcome = created.get();
    if (createdOutcome.type !== 'created') return Result.Ok(createdOutcome);
    renderIds.push(createdOutcome.renderId);
  }
  return Result.Ok({ type: 'render_submitted', renderIds });
}

// ---- Reading renders ------------------------------------------------------

/** Provider request ids stay server-side. */
export type RenderResultView = Omit<
  RenderResult,
  'providerRequestId' | 'errorMessage'
> & {
  retryable: boolean;
  failure:
    | { type: 'recovery_failed' }
    | { type: 'render_failure'; message: string }
    | { type: 'none' };
  outputUrl: string | null;
  outputSize: { width: number; height: number } | null;
};
export type RenderView = Omit<Render, 'results'> & {
  results: RenderResultView[];
  /** Signed working image of the render source (tree thumbnails, compare). */
  sourceUrl: string | null;
  sourceSize: { width: number; height: number } | null;
  /** Signed combined edit mask (white = edit), for the change checker. */
  editMaskUrl: string | null;
};

const signedImage = async (
  deps: RenderingUseCaseDeps,
  imageId: ImageId
): Promise<
  RenderingResult<{
    url: string;
    size: { width: number; height: number };
  } | null>
> => {
  const image = await deps.renderInputs.sourceImage(imageId);
  if (image.isError()) return Result.Error(image.getError());
  const outcome = image.get();
  if (outcome.type !== 'found') return Result.Ok(null);
  const signed = await deps.objectStorage.createSignedReadUrl({
    objectKey: outcome.image.workingKey,
    expiresInSeconds: SIGNED_VIEW_URL_SECONDS,
  });
  if (signed.isError()) return Result.Error(signed.getError());
  return Result.Ok({
    url: signed.get().url,
    size: { width: outcome.image.width, height: outcome.image.height },
  });
};

const toRenderView = async (
  deps: RenderingUseCaseDeps,
  render: Render
): Promise<RenderingResult<RenderView>> => {
  const results: RenderResultView[] = [];
  const cutoff = renderRetryCutoff(deps.clock.now());
  for (const result of render.results) {
    let output: {
      url: string;
      size: { width: number; height: number };
    } | null = null;
    if (result.outputImageId) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of results.
      const signed = await signedImage(deps, result.outputImageId);
      if (signed.isError()) return Result.Error(signed.getError());
      output = signed.get();
    }
    const {
      providerRequestId: _providerRequestId,
      errorMessage: _errorMessage,
      ...visible
    } = result;
    results.push({
      ...visible,
      retryable: isRenderRetryable(result, cutoff),
      failure:
        result.status !== 'failed'
          ? { type: 'none' }
          : result.errorMessage === 'submission_recovery_failed' ||
              result.errorMessage?.startsWith('PROVIDER_RECEIPT_') ||
              result.errorMessage === 'RENDER_ACCOUNTING_IDENTITY_MISSING' ||
              result.errorMessage === 'RENDER_SUBMISSION_DEADLINE_INVALID'
            ? { type: 'recovery_failed' }
            : { type: 'render_failure', message: result.errorMessage ?? '' },
      outputUrl: output?.url ?? null,
      outputSize: output?.size ?? null,
    });
  }
  const source = await signedImage(deps, render.renderSourceImageId);
  if (source.isError()) return Result.Error(source.getError());
  let editMaskUrl: string | null = null;
  if (render.recipe.editMaskKey) {
    const mask = await deps.objectStorage.createSignedReadUrl({
      objectKey: render.recipe.editMaskKey,
      expiresInSeconds: SIGNED_VIEW_URL_SECONDS,
    });
    if (mask.isError()) return Result.Error(mask.getError());
    editMaskUrl = mask.get().url;
  }
  return Result.Ok({
    ...render,
    results,
    sourceUrl: source.get()?.url ?? null,
    sourceSize: source.get()?.size ?? null,
    editMaskUrl,
  });
};

export type ListRendersOutcome =
  | { type: 'renders_listed'; renders: RenderView[] }
  | RenderingForbidden
  | ImageNotFound;

/** Every render of the design that the base image belongs to (history/tree). */
export async function listRenders(
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId; imageId: ImageId }
): Promise<RenderingResult<ListRendersOutcome>> {
  const owned = await loadOwnedSource(deps, { ...input, action: 'read' });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);
  const listed = await deps.renderRepository.listRenders(
    ownedOutcome.source.designId
  );
  if (listed.isError()) return Result.Error(listed.getError());
  const renders: RenderView[] = [];
  for (const render of listed.get().renders) {
    // oxlint-disable-next-line no-await-in-loop -- signing is local HMAC.
    const view = await toRenderView(deps, render);
    if (view.isError()) return Result.Error(view.getError());
    renders.push(view.get());
  }
  return Result.Ok({ type: 'renders_listed', renders });
}

type ResultMutationOutcome =
  | { type: 'render_updated'; render: RenderView }
  | { type: 'result_not_found' }
  | { type: 'result_not_retryable' }
  | { type: 'result_not_ready' }
  | RenderingForbidden;

const loadOwnedResult = async (
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId; resultId: RenderResultId }
): Promise<
  RenderingResult<
    | { type: 'ok'; render: Render; result: RenderResult }
    | { type: 'result_not_found' }
    | RenderingForbidden
  >
> => {
  const found = await deps.renderRepository.findResult(input.resultId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'result_not_found') return Result.Ok(outcome);
  const owned = await loadOwnedSource(deps, {
    currentUserId: input.currentUserId,
    imageId: outcome.render.renderSourceImageId,
    action: 'update',
  });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type === 'image_not_found')
    return Result.Ok({ type: 'result_not_found' });
  if (ownedOutcome.type === 'rendering_forbidden')
    return Result.Ok(ownedOutcome);
  return Result.Ok({
    type: 'ok',
    render: outcome.render,
    result: outcome.result,
  });
};

const reloadView = async (
  deps: RenderingUseCaseDeps,
  renderId: RenderId
): Promise<RenderingResult<ResultMutationOutcome>> => {
  const render = await deps.renderRepository.findRender(renderId);
  if (render.isError()) return Result.Error(render.getError());
  const renderOutcome = render.get();
  if (renderOutcome.type === 'render_not_found')
    return Result.Ok({ type: 'result_not_found' });
  const view = await toRenderView(deps, renderOutcome.render);
  if (view.isError()) return Result.Error(view.getError());
  return Result.Ok({ type: 'render_updated', render: view.get() });
};

/** Start a fresh attempt for a failed or expired result. */
export async function retryResult(
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId; resultId: RenderResultId }
): Promise<RenderingResult<ResultMutationOutcome>> {
  const owned = await loadOwnedResult(deps, input);
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);
  const startedAt = deps.clock.now();
  const expiredBeforeMs = renderRetryCutoff(startedAt);
  if (!isRenderRetryable(ownedOutcome.result, expiredBeforeMs))
    return Result.Ok({ type: 'result_not_retryable' });
  const reset = await deps.renderRepository.retryAttempt({
    resultId: input.resultId,
    expectedAttempt: ownedOutcome.result.attempt,
    startedAt,
    expiredBeforeMs,
  });
  if (reset.isError()) return Result.Error(reset.getError());
  const claimed = reset.get();
  if (claimed.type === 'result_attempt_superseded')
    return Result.Ok({ type: 'result_not_retryable' });
  const scheduled = await deps.renderScheduler.scheduleResult({
    resultId: input.resultId,
    attempt: claimed.attempt,
    ...(claimed.cleanupId ? { cleanupId: claimed.cleanupId } : {}),
  });
  if (scheduled.isError()) return Result.Error(scheduled.getError());
  return reloadView(deps, ownedOutcome.render.id);
}

/** Mark (or clear) the one preferred result of a render. */
export async function markPreferredResult(
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId; resultId: RenderResultId; preferred: boolean }
): Promise<RenderingResult<ResultMutationOutcome>> {
  const owned = await loadOwnedResult(deps, input);
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);
  if (ownedOutcome.result.status !== 'succeeded')
    return Result.Ok({ type: 'result_not_ready' });
  const saved = await deps.renderRepository.setPreferredResult({
    renderId: ownedOutcome.render.id,
    resultId: input.preferred ? input.resultId : null,
  });
  if (saved.isError()) return Result.Error(saved.getError());
  return reloadView(deps, ownedOutcome.render.id);
}

/** Name a result as a scheme (or clear the name). */
export async function nameScheme(
  deps: RenderingUseCaseDeps,
  input: {
    currentUserId: UserId;
    resultId: RenderResultId;
    name: string | null;
  }
): Promise<RenderingResult<ResultMutationOutcome>> {
  const owned = await loadOwnedResult(deps, input);
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type !== 'ok') return Result.Ok(ownedOutcome);
  const saved = await deps.renderRepository.setSchemeName({
    designId: ownedOutcome.render.designId,
    resultId: input.resultId,
    name: input.name?.trim() ? input.name.trim().slice(0, 120) : null,
  });
  if (saved.isError()) return Result.Error(saved.getError());
  return reloadView(deps, ownedOutcome.render.id);
}

// ---- Review -------------------------------------------------------------

export type GetRenderOutcome =
  | { type: 'render_found'; render: RenderView }
  | { type: 'render_not_found' }
  | RenderingForbidden;

/** One render with its results (results grid, compare, checker). */
export async function getRender(
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId; renderId: RenderId }
): Promise<RenderingResult<GetRenderOutcome>> {
  const found = await deps.renderRepository.findRender(input.renderId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'render_not_found') return Result.Ok(outcome);
  const owned = await loadOwnedSource(deps, {
    currentUserId: input.currentUserId,
    imageId: outcome.render.renderSourceImageId,
    action: 'read',
  });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type === 'image_not_found')
    return Result.Ok({ type: 'render_not_found' });
  if (ownedOutcome.type === 'rendering_forbidden')
    return Result.Ok(ownedOutcome);
  const view = await toRenderView(deps, outcome.render);
  if (view.isError()) return Result.Error(view.getError());
  return Result.Ok({ type: 'render_found', render: view.get() });
}

export type ScorecardRow = {
  modelId: string;
  /** Finished results. */
  succeeded: number;
  /** Times this model's result was the preferred one. */
  preferred: number;
  /** Finished results in renders that have a preferred result. */
  contested: number;
};

export type ScorecardOutcome =
  | { type: 'scorecard'; rows: ScorecardRow[] }
  | RenderingForbidden;

/** How often each model's result was preferred, across the user's designs. */
export async function getScorecard(
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId }
): Promise<RenderingResult<ScorecardOutcome>> {
  const permission = await deps.permissionChecker.hasPermission(
    input.currentUserId,
    {
      design: ['read'],
    }
  );
  if (permission.isError()) return Result.Error(permission.getError());
  if (permission.get().type === 'permission_denied') {
    return Result.Ok({ type: 'rendering_forbidden' });
  }
  const rows = await deps.renderRepository.scorecard(input.currentUserId);
  if (rows.isError()) return Result.Error(rows.getError());
  return Result.Ok({
    type: 'scorecard',
    rows: rows.get().rows.map((row) => ({
      modelId: row.modelId,
      succeeded: row.succeeded,
      preferred: row.preferred,
      contested: row.rendersWithPreference,
    })),
  });
}

const MAX_LINEAGE = 50;

export type DraftFromOriginalOutcome =
  | {
      type: 'draft_rebuilt';
      baseImageId: ImageId;
      edits: number;
      /** Edits that could not be mapped onto the base image (reported, not hidden). */
      omitted: { unmappableRegion: number; editLimit: number };
    }
  | { type: 'draft_conflict' }
  | { type: 'render_not_found' }
  | RenderingForbidden;

/**
 * "Compare from original": combine the edits of a render and every render
 * it continued from into one editable draft on the base image. Regions made
 * on results map back through region carry-over; others are reported.
 */
export async function draftFromOriginal(
  deps: RenderingUseCaseDeps,
  input: { currentUserId: UserId; renderId: RenderId }
): Promise<RenderingResult<DraftFromOriginalOutcome>> {
  const found = await deps.renderRepository.findRender(input.renderId);
  if (found.isError()) return Result.Error(found.getError());
  const start = found.get();
  if (start.type === 'render_not_found') return Result.Ok(start);

  const chain: Render[] = [start.render];
  let baseImageId = start.render.renderSourceImageId;
  for (let hop = 0; hop < MAX_LINEAGE; hop += 1) {
    // oxlint-disable-next-line no-await-in-loop -- walks a short lineage.
    const parent =
      await deps.renderRepository.findRenderByOutputImage(baseImageId);
    if (parent.isError()) return Result.Error(parent.getError());
    const parentOutcome = parent.get();
    if (parentOutcome.type === 'render_not_found') break;
    chain.unshift(parentOutcome.render);
    baseImageId = parentOutcome.render.renderSourceImageId;
  }

  const owned = await loadOwnedSource(deps, {
    currentUserId: input.currentUserId,
    imageId: baseImageId,
    action: 'update',
  });
  if (owned.isError()) return Result.Error(owned.getError());
  const ownedOutcome = owned.get();
  if (ownedOutcome.type === 'image_not_found')
    return Result.Ok({ type: 'render_not_found' });
  if (ownedOutcome.type === 'rendering_forbidden')
    return Result.Ok(ownedOutcome);

  const toBaseRegion = async (
    regionId: string
  ): Promise<RenderingResult<string | null>> => {
    let current = regionId;
    for (let hop = 0; hop < MAX_LINEAGE; hop += 1) {
      // oxlint-disable-next-line no-await-in-loop -- follows carry-over links.
      const region = await deps.renderInputs.region(current);
      if (region.isError()) return Result.Error(region.getError());
      const outcome = region.get();
      if (outcome.type === 'missing') return Result.Ok(null);
      if (outcome.region.imageId === baseImageId)
        return Result.Ok(outcome.region.regionId);
      if (!outcome.region.carriedFromRegionId) return Result.Ok(null);
      current = outcome.region.carriedFromRegionId;
    }
    return Result.Ok(null);
  };

  const edits: Edit[] = [];
  let unmappableRegion = 0;
  for (const [index, render] of chain.entries()) {
    for (const edit of render.recipe.edits) {
      const id = `r${index}-${edit.id}`.slice(0, 64);
      if (edit.kind === 'placement') {
        edits.push({
          kind: 'placement',
          id,
          itemId: edit.item.itemId,
          box: edit.box,
          rotationDeg: edit.rotationDeg,
          note: edit.note,
        });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- a handful of edits.
      const mapped = await toBaseRegion(edit.region.regionId);
      if (mapped.isError()) return Result.Error(mapped.getError());
      const regionId = mapped.get();
      if (!regionId) {
        unmappableRegion += 1;
        continue;
      }
      if (edit.kind === 'removal')
        edits.push({ kind: 'removal', id, regionId, note: edit.note });
      else if (edit.kind === 'replacement') {
        edits.push({
          kind: 'replacement',
          id,
          regionId,
          itemId: edit.item.itemId,
          note: edit.note,
        });
      } else {
        edits.push({
          kind: 'material',
          id,
          regionId,
          swatchItemId: edit.swatch?.itemId ?? null,
          text: edit.text,
        });
      }
    }
  }
  const kept = edits.slice(0, MAX_EDITS);
  const prompt = [
    ...new Set(
      chain.map((render) => render.recipe.prompt.trim()).filter(Boolean)
    ),
  ]
    .join('\n')
    .slice(0, PROMPT_MAX_LENGTH);

  const current = await deps.renderRepository.findDraft(baseImageId);
  if (current.isError()) return Result.Error(current.getError());
  const currentOutcome = current.get();
  const saved = await deps.renderRepository.saveDraft({
    designId: ownedOutcome.source.designId,
    renderSourceImageId: baseImageId,
    editSet: { edits: kept, prompt },
    expectedRevision:
      currentOutcome.type === 'draft_found' ? currentOutcome.draft.revision : 0,
  });
  if (saved.isError()) return Result.Error(saved.getError());
  if (saved.get().type === 'draft_conflict')
    return Result.Ok({ type: 'draft_conflict' });
  return Result.Ok({
    type: 'draft_rebuilt',
    baseImageId,
    edits: kept.length,
    omitted: { unmappableRegion, editLimit: edits.length - kept.length },
  });
}
