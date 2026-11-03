import { z } from 'zod';

import type { ProtectedContext } from '@/modules/auth/backend';
import {
  zImageId,
  zItemId,
  zRenderId,
  zRenderResultId,
} from '@/modules/kernel/domain/ids';
import { unwrapApplicationResult } from '@/modules/kernel/transport/tanstack/result-mapper';

import type {
  DraftFromOriginalOutcome,
  RenderSourceView,
  RenderView,
  ScorecardRow,
} from '../../application/use-cases/renders';
import type { RecipeProblem } from '../../application/use-cases/resolve-recipe';
import { zEditSet } from '../../domain/edit-set';
import type { Draft } from '../../domain/render';
import type { RenderPlan } from '../../domain/render-plan';
import type { RenderingUseCases } from '../../factory';

export const SCHEME_NAME_MAX_LENGTH = 120;
export const MAX_BATCH_OPTIONS = 8;

export const zImageInput = () => z.object({ imageId: zImageId() });
export const zSaveDraftInput = () =>
  z.object({
    imageId: zImageId(),
    editSet: zEditSet(),
    revision: z.number().int().min(0),
  });
export const zPreviewPlanInput = () =>
  z.object({ imageId: zImageId(), editSet: zEditSet() });
export const zSubmitRenderInput = () =>
  z.object({ imageId: zImageId(), revision: z.number().int().min(0) });
export const zSubmitBatchInput = () =>
  z.object({
    imageId: zImageId(),
    revision: z.number().int().min(1),
    placementEditId: z.string().min(1).max(64),
    optionItemIds: z.array(zItemId()).min(2).max(MAX_BATCH_OPTIONS),
  });
export const zRenderInput = () => z.object({ renderId: zRenderId() });
export const zResultInput = () => z.object({ resultId: zRenderResultId() });
export const zPreferInput = () =>
  z.object({ resultId: zRenderResultId(), preferred: z.boolean() });
export const zSchemeInput = () =>
  z.object({
    resultId: zRenderResultId(),
    name: z.string().trim().max(SCHEME_NAME_MAX_LENGTH).nullable(),
  });

export type DraftSaveResponse =
  | { type: 'saved'; draft: Draft }
  | { type: 'conflict'; draft: Draft };

export type RecipeProblemResponse = { type: 'problem'; problem: RecipeProblem };
export type PlanResponse =
  | { type: 'plan'; plan: RenderPlan }
  | RecipeProblemResponse;
export type SubmitResponse =
  | { type: 'submitted'; renderIds: string[] }
  | { type: 'draft_out_of_date' }
  | { type: 'no_models_can_render' }
  | RecipeProblemResponse;

const access = {
  rendering_forbidden: 'FORBIDDEN',
  image_not_found: 'NOT_FOUND',
} as const;
const resultAccess = {
  rendering_forbidden: 'FORBIDDEN',
  result_not_found: 'NOT_FOUND',
} as const;
const problem = (outcome: RecipeProblem): RecipeProblemResponse => ({
  type: 'problem',
  problem: outcome,
});
const recipeProblems = {
  item_missing: problem,
  item_not_ready: problem,
  region_missing: problem,
  nothing_to_render: problem,
} as const;

const toSubmitResponse = {
  ...access,
  ...recipeProblems,
  render_submitted: (outcome: { renderIds: string[] }): SubmitResponse => ({
    type: 'submitted',
    renderIds: outcome.renderIds,
  }),
  draft_out_of_date: (): SubmitResponse => ({ type: 'draft_out_of_date' }),
  no_models_can_render: (): SubmitResponse => ({
    type: 'no_models_can_render',
  }),
} as const;

const toRenderView = {
  ...resultAccess,
  render_updated: (outcome: { render: RenderView }) => outcome.render,
  result_not_retryable: {
    code: 'BAD_REQUEST',
    message: 'Only failed results can be retried.',
  },
  result_not_ready: {
    code: 'BAD_REQUEST',
    message: 'Only finished results can be preferred.',
  },
} as const;

export const createRenderingHandlers = ({
  getUseCases,
}: {
  getUseCases: (ctx: ProtectedContext) => RenderingUseCases;
}) => ({
  getRenderSource: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zImageInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).getRenderSource({
        currentUserId: ctx.scope.userId,
        imageId: data.imageId,
      }),
      {
        ...access,
        render_source: (outcome: { source: RenderSourceView }) =>
          outcome.source,
      }
    ),
  getDraft: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zImageInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).getDraft({
        currentUserId: ctx.scope.userId,
        imageId: data.imageId,
      }),
      { ...access, draft: (outcome: { draft: Draft }) => outcome.draft }
    ),
  saveDraft: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zSaveDraftInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).saveDraft({ currentUserId: ctx.scope.userId, ...data }),
      {
        ...access,
        draft_saved: (outcome: { draft: Draft }): DraftSaveResponse => ({
          type: 'saved',
          draft: outcome.draft,
        }),
        draft_conflict: (outcome: { draft: Draft }): DraftSaveResponse => ({
          type: 'conflict',
          draft: outcome.draft,
        }),
      }
    ),
  previewPlan: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zPreviewPlanInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).previewPlan({
        currentUserId: ctx.scope.userId,
        ...data,
      }),
      {
        ...access,
        ...recipeProblems,
        render_plan: (outcome: { plan: RenderPlan }): PlanResponse => ({
          type: 'plan',
          plan: outcome.plan,
        }),
      }
    ),
  submitRender: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zSubmitRenderInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).submitRender({
        currentUserId: ctx.scope.userId,
        ...data,
      }),
      toSubmitResponse
    ),
  submitBatch: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zSubmitBatchInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).submitBatch({
        currentUserId: ctx.scope.userId,
        ...data,
      }),
      toSubmitResponse
    ),
  listRenders: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zImageInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).listRenders({
        currentUserId: ctx.scope.userId,
        imageId: data.imageId,
      }),
      {
        ...access,
        renders_listed: (outcome: { renders: RenderView[] }) => outcome.renders,
      }
    ),
  retryResult: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zResultInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).retryResult({
        currentUserId: ctx.scope.userId,
        ...data,
      }),
      toRenderView
    ),
  markPreferred: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zPreferInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).markPreferredResult({
        currentUserId: ctx.scope.userId,
        ...data,
      }),
      toRenderView
    ),
  getRender: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zRenderInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).getRender({
        currentUserId: ctx.scope.userId,
        renderId: data.renderId,
      }),
      {
        rendering_forbidden: 'FORBIDDEN',
        render_not_found: 'NOT_FOUND',
        render_found: (outcome: { render: RenderView }) => outcome.render,
      }
    ),
  getScorecard: (ctx: ProtectedContext) =>
    unwrapApplicationResult(
      getUseCases(ctx).getScorecard({ currentUserId: ctx.scope.userId }),
      {
        rendering_forbidden: 'FORBIDDEN',
        scorecard: (outcome: { rows: ScorecardRow[] }) => outcome.rows,
      }
    ),
  draftFromOriginal: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zRenderInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).draftFromOriginal({
        currentUserId: ctx.scope.userId,
        renderId: data.renderId,
      }),
      {
        rendering_forbidden: 'FORBIDDEN',
        render_not_found: 'NOT_FOUND',
        draft_conflict: (outcome: { type: 'draft_conflict' }) => outcome,
        draft_rebuilt: (outcome: RebuiltDraftResponse): RebuiltDraftResponse =>
          outcome,
      }
    ),
  nameScheme: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zSchemeInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).nameScheme({ currentUserId: ctx.scope.userId, ...data }),
      toRenderView
    ),
});

export type RebuiltDraftResponse = Extract<
  DraftFromOriginalOutcome,
  { type: 'draft_rebuilt' }
>;
export type RenderingHandlers = ReturnType<typeof createRenderingHandlers>;
