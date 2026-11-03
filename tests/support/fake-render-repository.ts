import { Result } from '@bloodyowl/boxed';

import { AppError } from '@/modules/kernel';
import type { ImageId } from '@/modules/kernel/domain/ids';
import type { Draft, Render, RenderRepository } from '@/modules/rendering';

/** In-memory {@link RenderRepository} with the same revision semantics. */
export const createFakeRenderRepository = (now: () => Date) => {
  const drafts = new Map<ImageId, Draft>();
  const renders: Render[] = [];

  const findResult = (resultId: string) => {
    for (const render of renders) {
      const result = render.results.find((r) => r.id === resultId);
      if (result) return { render, result };
    }
    return undefined;
  };

  const repository: RenderRepository = {
    async findDraft(imageId) {
      const draft = drafts.get(imageId);
      return Result.Ok(
        draft ? { type: 'draft_found', draft } : { type: 'draft_missing' }
      );
    },
    async saveDraft(input) {
      const current = drafts.get(input.renderSourceImageId);
      const currentRevision = current?.revision ?? 0;
      if (current && currentRevision !== input.expectedRevision) {
        return Result.Ok({ type: 'draft_conflict', draft: current });
      }
      if (!current && input.expectedRevision !== 0) {
        return Result.Error(
          new AppError({
            code: 'DRAFT_MISSING',
            category: 'system',
            status: 500,
            message: 'draft vanished',
          })
        );
      }
      const draft: Draft = {
        designId: input.designId,
        renderSourceImageId: input.renderSourceImageId,
        editSet: input.editSet,
        revision: currentRevision + 1,
        updatedAt: now(),
      };
      drafts.set(input.renderSourceImageId, draft);
      return Result.Ok({ type: 'draft_saved', draft });
    },
    async createRender(input) {
      const render: Render = {
        id: input.id,
        designId: input.designId,
        renderSourceImageId: input.renderSourceImageId,
        batchId: input.batchId,
        batchOptionItemId: input.batchOptionItemId,
        recipe: input.recipe,
        preferredResultId: null,
        createdAt: now(),
        results: input.results.map((result) => ({
          id: result.id,
          renderId: input.id,
          modelId: result.modelId,
          status: result.status,
          skipReason: result.skipReason,
          attempt: 1,
          providerRequestId: null,
          modelVersion: null,
          settings: {},
          prompt: null,
          outputImageId: null,
          framingChanged: false,
          errorMessage: null,
          costUsdMicros: null,
          costSource: null,
          schemeName: null,
          submittedAt: null,
          completedAt: null,
        })),
      };
      renders.unshift(render);
      return Result.Ok({ type: 'render_created', render });
    },
    async findRender(renderId) {
      const render = renders.find((r) => r.id === renderId);
      return Result.Ok(
        render ? { type: 'render_found', render } : { type: 'render_not_found' }
      );
    },
    async listRenders(designId) {
      return Result.Ok({
        type: 'renders_listed',
        renders: renders.filter((r) => r.designId === designId),
      });
    },
    async findRenderByOutputImage(imageId) {
      const render = renders.find((r) =>
        r.results.some((result) => result.outputImageId === imageId)
      );
      return Result.Ok(
        render ? { type: 'render_found', render } : { type: 'render_not_found' }
      );
    },
    async scorecard() {
      const counts = new Map<
        string,
        { succeeded: number; preferred: number; rendersWithPreference: number }
      >();
      for (const render of renders) {
        for (const result of render.results) {
          const row = counts.get(result.modelId) ?? {
            succeeded: 0,
            preferred: 0,
            rendersWithPreference: 0,
          };
          if (result.status === 'succeeded') row.succeeded += 1;
          if (render.preferredResultId === result.id) row.preferred += 1;
          if (result.status === 'succeeded' && render.preferredResultId)
            row.rendersWithPreference += 1;
          counts.set(result.modelId, row);
        }
      }
      return Result.Ok({
        type: 'scorecard',
        rows: [...counts].map(([modelId, row]) => ({ modelId, ...row })),
      });
    },
    async findResult(resultId) {
      const found = findResult(resultId);
      return Result.Ok(
        found
          ? { type: 'result_found', ...found }
          : { type: 'result_not_found' }
      );
    },
    async updateResult(input) {
      const found = findResult(input.resultId);
      if (found) Object.assign(found.result, input.changes);
      return Result.Ok({ type: 'result_updated' });
    },
    async setPreferredResult(input) {
      const render = renders.find((r) => r.id === input.renderId);
      if (render) render.preferredResultId = input.resultId;
      return Result.Ok({ type: 'preferred_result_set' });
    },
    async setSchemeName(input) {
      const found = findResult(input.resultId);
      if (found) found.result.schemeName = input.name;
      return Result.Ok({ type: 'scheme_saved' });
    },
  };
  return { repository, drafts, renders };
};
