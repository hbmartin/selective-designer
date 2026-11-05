import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import type { ProviderCostSource } from '@/modules/kernel';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import {
  toBatchId,
  toDesignId,
  toImageId,
  toRenderId,
  toRenderResultId,
} from '@/modules/kernel/domain/ids';
import { observeRepository } from '@/modules/kernel/infrastructure/db/observability';
import { design as designTable } from '@/modules/kernel/infrastructure/db/schema';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';
import type { RenderRepository } from '@/modules/rendering/application/ports/ports';
import { isModelId, modelIds } from '@/modules/rendering/domain/model-catalog';
import {
  type Draft,
  type Render,
  type RenderResult,
  type RenderResultStatus,
  renderResultStatuses,
} from '@/modules/rendering/domain/render';

import {
  render as renderTable,
  renderDraft as draftTable,
  type RenderDraftRow,
  renderResult as resultTable,
  type RenderResultRow,
  type RenderRow,
} from './schema';

const rowError = (cause: unknown) =>
  new AppError({
    code: 'RENDER_ROW_INVALID',
    category: 'system',
    status: 500,
    message: 'Render row contains invalid data',
    cause,
  });
const dbError = (cause: unknown) =>
  new AppError({
    code: 'RENDER_REPOSITORY_ERROR',
    category: 'system',
    status: 500,
    message: 'Render persistence failed',
    cause,
  });

const isStatus = (value: string): value is RenderResultStatus =>
  (renderResultStatuses as readonly string[]).includes(value);
const costSources = ['reported', 'price_table', 'unavailable'] as const;
const toCostSource = (value: string | null): ProviderCostSource | null =>
  value !== null && (costSources as readonly string[]).includes(value)
    ? (value as ProviderCostSource)
    : null;

const toDraft = (row: RenderDraftRow): BoxedResult<Draft, AppError> => {
  const designId = toDesignId(row.designId);
  const imageId = toImageId(row.renderSourceImageId);
  if (designId.isError() || imageId.isError())
    return Result.Error(rowError(row.id));
  return Result.Ok({
    designId: designId.get(),
    renderSourceImageId: imageId.get(),
    editSet: row.editSet,
    revision: row.revision,
    updatedAt: row.updatedAt,
  });
};

const toResult = (
  row: RenderResultRow
): BoxedResult<RenderResult, AppError> => {
  const id = toRenderResultId(row.id);
  const renderId = toRenderId(row.renderId);
  const outputImageId = row.outputImageId
    ? toImageId(row.outputImageId)
    : undefined;
  if (
    id.isError() ||
    renderId.isError() ||
    (outputImageId !== undefined && outputImageId.isError()) ||
    !isModelId(row.modelId) ||
    !isStatus(row.status)
  ) {
    return Result.Error(rowError(row.id));
  }
  return Result.Ok({
    id: id.get(),
    renderId: renderId.get(),
    modelId: row.modelId,
    status: row.status,
    skipReason: row.skipReason,
    attempt: row.attempt,
    providerRequestId: row.providerRequestId,
    modelVersion: row.modelVersion,
    settings: row.settings,
    prompt: row.prompt,
    outputImageId: outputImageId?.isOk() ? outputImageId.get() : null,
    framingChanged: row.framingChanged,
    errorMessage: row.errorMessage,
    costUsdMicros: row.costUsdMicros,
    costSource: toCostSource(row.costSource),
    schemeName: row.schemeName,
    submittedAt: row.submittedAt,
    completedAt: row.completedAt,
  });
};

const toRender = (
  row: RenderRow,
  resultRows: RenderResultRow[]
): BoxedResult<Render, AppError> => {
  const id = toRenderId(row.id);
  const designId = toDesignId(row.designId);
  const sourceId = toImageId(row.renderSourceImageId);
  const batchId = row.batchId ? toBatchId(row.batchId) : undefined;
  const preferred = row.preferredResultId
    ? toRenderResultId(row.preferredResultId)
    : undefined;
  if (
    id.isError() ||
    designId.isError() ||
    sourceId.isError() ||
    (batchId !== undefined && batchId.isError()) ||
    (preferred !== undefined && preferred.isError())
  ) {
    return Result.Error(rowError(row.id));
  }
  const results: RenderResult[] = [];
  for (const resultRow of resultRows) {
    const parsed = toResult(resultRow);
    if (parsed.isError()) return Result.Error(parsed.getError());
    results.push(parsed.get());
  }
  return Result.Ok({
    id: id.get(),
    designId: designId.get(),
    renderSourceImageId: sourceId.get(),
    batchId: batchId?.isOk() ? batchId.get() : null,
    batchOptionItemId: row.batchOptionItemId,
    recipe: row.recipe,
    preferredResultId: preferred?.isOk() ? preferred.get() : null,
    results,
    createdAt: row.createdAt,
  });
};

const byCreation = [asc(resultTable.createdAt), asc(resultTable.id)];

export const createRenderRepository = ({
  db,
  modelOrder = modelIds,
}: {
  db: DbLike;
  modelOrder?: readonly string[];
}): RenderRepository => {
  // Disabled models can still have historical results. Keep them in catalog order.
  const orderedModels = [...new Set([...modelOrder, ...modelIds])];
  const modelRank = (modelId: string) => {
    const index = orderedModels.indexOf(modelId);
    return index === -1 ? orderedModels.length : index;
  };
  const loadRenders = async (rows: RenderRow[]) => {
    if (rows.length === 0) return Result.Ok<Render[], AppError>([]);
    const resultRows = await db
      .select()
      .from(resultTable)
      .where(
        inArray(
          resultTable.renderId,
          rows.map((row) => row.id)
        )
      )
      .orderBy(...byCreation);
    const renders: Render[] = [];
    for (const row of rows) {
      const parsed = toRender(
        row,
        resultRows
          .filter((r) => r.renderId === row.id)
          .toSorted((a, b) => modelRank(a.modelId) - modelRank(b.modelId))
      );
      if (parsed.isError())
        return Result.Error<Render[], AppError>(parsed.getError());
      renders.push(parsed.get());
    }
    return Result.Ok<Render[], AppError>(renders);
  };

  const repository: RenderRepository = {
    async findDraft(renderSourceImageId) {
      try {
        const [row] = await db
          .select()
          .from(draftTable)
          .where(eq(draftTable.renderSourceImageId, renderSourceImageId))
          .limit(1);
        if (!row) return Result.Ok({ type: 'draft_missing' });
        const draft = toDraft(row);
        if (draft.isError()) return Result.Error(draft.getError());
        return Result.Ok({ type: 'draft_found', draft: draft.get() });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async saveDraft(input) {
      try {
        const next = input.expectedRevision + 1;
        const saved =
          input.expectedRevision === 0
            ? await db
                .insert(draftTable)
                .values({
                  designId: input.designId,
                  renderSourceImageId: input.renderSourceImageId,
                  editSet: input.editSet,
                  revision: 1,
                })
                .onConflictDoNothing()
                .returning()
            : await db
                .update(draftTable)
                .set({ editSet: input.editSet, revision: next })
                .where(
                  and(
                    eq(
                      draftTable.renderSourceImageId,
                      input.renderSourceImageId
                    ),
                    eq(draftTable.revision, input.expectedRevision)
                  )
                )
                .returning();
        const [row] = saved;
        if (row) {
          const draft = toDraft(row);
          if (draft.isError()) return Result.Error(draft.getError());
          return Result.Ok({ type: 'draft_saved', draft: draft.get() });
        }
        const current = await repository.findDraft(input.renderSourceImageId);
        if (current.isError()) return Result.Error(current.getError());
        const currentOutcome = current.get();
        if (currentOutcome.type === 'draft_missing') {
          return Result.Error(dbError('draft vanished during save'));
        }
        return Result.Ok({
          type: 'draft_conflict',
          draft: currentOutcome.draft,
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async createRender(input) {
      try {
        await db.transaction(async (tx) => {
          await tx.insert(renderTable).values({
            id: input.id,
            designId: input.designId,
            renderSourceImageId: input.renderSourceImageId,
            batchId: input.batchId,
            batchOptionItemId: input.batchOptionItemId,
            recipe: input.recipe,
          });
          if (input.results.length > 0) {
            await tx.insert(resultTable).values(
              input.results.map((result) => ({
                id: result.id,
                renderId: input.id,
                modelId: result.modelId,
                status: result.status,
                skipReason: result.skipReason,
              }))
            );
          }
        });
        const found = await repository.findRender(input.id);
        if (found.isError()) return Result.Error(found.getError());
        const outcome = found.get();
        if (outcome.type === 'render_not_found')
          return Result.Error(dbError('created render missing'));
        return Result.Ok({ type: 'render_created', render: outcome.render });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async findRender(renderId) {
      try {
        const rows = await db
          .select()
          .from(renderTable)
          .where(eq(renderTable.id, renderId))
          .limit(1);
        const renders = await loadRenders(rows);
        if (renders.isError()) return Result.Error(renders.getError());
        const [first] = renders.get();
        return Result.Ok(
          first
            ? { type: 'render_found', render: first }
            : { type: 'render_not_found' }
        );
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async listRenders(designId) {
      try {
        const rows = await db
          .select()
          .from(renderTable)
          .where(eq(renderTable.designId, designId))
          .orderBy(desc(renderTable.createdAt), desc(renderTable.id));
        const renders = await loadRenders(rows);
        if (renders.isError()) return Result.Error(renders.getError());
        return Result.Ok({ type: 'renders_listed', renders: renders.get() });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async findRenderByOutputImage(imageId) {
      try {
        const [row] = await db
          .select({ renderId: resultTable.renderId })
          .from(resultTable)
          .where(eq(resultTable.outputImageId, imageId))
          .limit(1);
        if (!row) return Result.Ok({ type: 'render_not_found' });
        const renderId = toRenderId(row.renderId);
        if (renderId.isError()) return Result.Error(rowError(row.renderId));
        return await repository.findRender(renderId.get());
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async scorecard(ownerId) {
      try {
        const rows = await db
          .select({
            modelId: resultTable.modelId,
            succeeded:
              sql<number>`count(*) filter (where ${resultTable.status} = 'succeeded')`.mapWith(
                Number
              ),
            preferred:
              sql<number>`count(*) filter (where ${renderTable.preferredResultId} = ${resultTable.id})`.mapWith(
                Number
              ),
            rendersWithPreference:
              sql<number>`count(*) filter (where ${resultTable.status} = 'succeeded' and ${renderTable.preferredResultId} is not null)`.mapWith(
                Number
              ),
          })
          .from(resultTable)
          .innerJoin(renderTable, eq(renderTable.id, resultTable.renderId))
          .innerJoin(designTable, eq(designTable.id, renderTable.designId))
          .where(eq(designTable.ownerId, ownerId))
          .groupBy(resultTable.modelId);
        return Result.Ok({
          type: 'scorecard',
          rows: rows.toSorted(
            (a, b) => modelRank(a.modelId) - modelRank(b.modelId)
          ),
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async findResult(resultId) {
      try {
        const [row] = await db
          .select({ renderId: resultTable.renderId })
          .from(resultTable)
          .where(eq(resultTable.id, resultId))
          .limit(1);
        if (!row) return Result.Ok({ type: 'result_not_found' });
        const renderId = toRenderId(row.renderId);
        if (renderId.isError()) return Result.Error(rowError(resultId));
        const found = await repository.findRender(renderId.get());
        if (found.isError()) return Result.Error(found.getError());
        const outcome = found.get();
        const result =
          outcome.type === 'render_found'
            ? outcome.render.results.find((r) => r.id === resultId)
            : undefined;
        return Result.Ok(
          outcome.type === 'render_found' && result
            ? { type: 'result_found', result, render: outcome.render }
            : { type: 'result_not_found' }
        );
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async failResultAttempt(input) {
      try {
        const rows = await db
          .update(resultTable)
          .set({
            status: 'failed',
            errorMessage: input.reason.slice(0, 500),
            completedAt: input.now,
          })
          .where(
            and(
              eq(resultTable.id, input.resultId),
              inArray(resultTable.status, ['pending', 'submitted']),
              input.attempt === undefined
                ? undefined
                : eq(resultTable.attempt, input.attempt),
              input.providerRequestId == null
                ? undefined
                : eq(resultTable.providerRequestId, input.providerRequestId)
            )
          )
          .returning({ id: resultTable.id });
        return Result.Ok({
          type: rows.length
            ? 'result_marked_failed'
            : 'result_attempt_superseded',
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async lockResultForCompletion(resultId) {
      try {
        const [row] = await db
          .select()
          .from(resultTable)
          .where(eq(resultTable.id, resultId))
          .for('update');
        if (!row) return Result.Ok({ type: 'result_not_found' });
        const parsed = toResult(row);
        if (parsed.isError()) return Result.Error(parsed.getError());
        return Result.Ok({ type: 'result_locked', result: parsed.get() });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async completeResultAttempt(input) {
      try {
        const rows = await db
          .update(resultTable)
          .set({
            ...input.completion,
            status: 'succeeded',
            outputImageId: input.imageId,
          })
          .where(
            and(
              eq(resultTable.id, input.resultId),
              eq(resultTable.attempt, input.attempt),
              eq(resultTable.providerRequestId, input.providerRequestId),
              eq(resultTable.status, 'submitted')
            )
          )
          .returning({ id: resultTable.id });
        return Result.Ok({
          type: rows.length ? 'result_completed' : 'result_attempt_superseded',
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async updateResult(input) {
      try {
        await db
          .update(resultTable)
          .set(input.changes)
          .where(eq(resultTable.id, input.resultId));
        return Result.Ok({ type: 'result_updated' });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async setPreferredResult(input) {
      try {
        await db
          .update(renderTable)
          .set({ preferredResultId: input.resultId })
          .where(eq(renderTable.id, input.renderId));
        return Result.Ok({ type: 'preferred_result_set' });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async setSchemeName(input) {
      try {
        await db
          .update(resultTable)
          .set({ schemeName: input.name })
          .where(eq(resultTable.id, input.resultId));
        return Result.Ok({ type: 'scheme_saved' });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
  };
  return observeRepository(repository, 'render');
};
