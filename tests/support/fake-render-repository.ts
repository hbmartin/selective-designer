import { Result } from '@bloodyowl/boxed';
import { isDeepStrictEqual } from 'node:util';

import { AppError, type ProviderAccounting } from '@/modules/kernel';
import type { ImageId } from '@/modules/kernel/domain/ids';
import type {
  Draft,
  Render,
  RenderOutputCheckpoint,
  RenderRepository,
} from '@/modules/rendering';
import { isRenderRetryable } from '@/modules/rendering';
import {
  isPlausibleRenderStart,
  renderAttemptDeadline,
} from '@/modules/rendering/testing';

/** In-memory {@link RenderRepository} with the same revision semantics. */
export const createFakeRenderRepository = (
  now: () => Date,
  accounting?: ProviderAccounting
) => {
  const drafts = new Map<ImageId, Draft>();
  const renders: Render[] = [];
  const owners = new Map<string, string>();
  const accountingIdentities = new Map<
    string,
    import('@/modules/rendering').RenderAccountingIdentity
  >();
  const checkpoints = new Map<string, RenderOutputCheckpoint>();

  const findResult = (resultId: string) => {
    for (const render of renders) {
      const result = render.results.find((r) => r.id === resultId);
      if (result) return { render, result };
    }
    return undefined;
  };

  const repository: RenderRepository = {
    async reconcileSubmission(input) {
      const found = findResult(input.resultId);
      if (
        !found ||
        found.result.attempt !== input.attempt ||
        owners.get(input.resultId) !== input.workflowRunId
      )
        return Result.Ok({ type: 'result_attempt_superseded' });
      if (
        found.result.providerRequestId === input.providerRequestId &&
        isDeepStrictEqual(
          accountingIdentities.get(input.resultId),
          input.accountingIdentity
        ) &&
        isDeepStrictEqual(found.result.settings, input.settings) &&
        found.result.prompt === input.prompt &&
        found.result.submittedAt?.getTime() === Date.parse(input.submittedAt) &&
        (found.result.status === 'submitted' ||
          found.result.status === 'succeeded')
      )
        return Result.Ok({
          type: 'result_submitted',
          providerRequestId: input.providerRequestId,
        });
      if (
        found.result.status !== 'pending' ||
        found.result.providerRequestId !== null
      )
        return Result.Ok({ type: 'result_attempt_superseded' });
      const deadline = renderAttemptDeadline(found.result.attemptStartedAt);
      if (
        deadline.type === 'render_deadline_invalid' ||
        !isPlausibleRenderStart(
          found.result.attemptStartedAt.getTime(),
          now().getTime()
        )
      )
        return Result.Error(
          new AppError({
            code: 'RENDER_ROW_INVALID',
            category: 'system',
            status: 500,
            retryable: false,
          })
        );
      return Result.Ok({
        type: 'submission_recovery_window',
        attemptDeadlineAt: deadline.deadlineAt,
      });
    },
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
          attemptStartedAt: input.attemptStartedAt,
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
    async claimExecution(input) {
      const found = findResult(input.resultId);
      if (
        !found ||
        found.result.attempt !== input.attempt ||
        !['pending', 'submitted', 'succeeded'].includes(found.result.status) ||
        (owners.has(input.resultId) &&
          owners.get(input.resultId) !== input.workflowRunId)
      )
        return Result.Ok({ type: 'result_attempt_superseded' });
      owners.set(input.resultId, input.workflowRunId);
      return Result.Ok({ type: 'result_execution_claimed' });
    },
    async saveSubmission(input) {
      const found = findResult(input.resultId);
      if (
        found &&
        found.result.attempt === input.attempt &&
        found.result.providerRequestId === input.providerRequestId &&
        ['submitted', 'succeeded'].includes(found.result.status) &&
        owners.get(input.resultId) === input.workflowRunId &&
        accountingIdentities.get(input.resultId)?.invocationId ===
          input.accountingIdentity.invocationId
      )
        return Result.Ok({ type: 'result_submitted' });
      if (
        !found ||
        found.result.attempt !== input.attempt ||
        found.result.status !== 'pending' ||
        found.result.providerRequestId !== null ||
        owners.get(input.resultId) !== input.workflowRunId
      )
        return Result.Ok({ type: 'result_attempt_superseded' });
      if (input.accountingIdentity)
        accountingIdentities.set(input.resultId, input.accountingIdentity);
      Object.assign(found.result, {
        status: 'submitted',
        providerRequestId: input.providerRequestId,
        settings: input.settings,
        prompt: input.prompt,
        submittedAt: new Date(input.submittedAt),
      });
      return Result.Ok({ type: 'result_submitted' });
    },
    async saveOutput(input) {
      if (accounting) {
        const captured = await accounting.capture(input.checkpoint.receipt);
        if (captured.isError()) return Result.Error(captured.getError());
      }
      const found = findResult(input.resultId);
      if (
        found?.result.attempt === input.attempt &&
        found.result.providerRequestId === input.providerRequestId &&
        found.result.status === 'succeeded'
      )
        return Result.Ok({ type: 'result_already_completed' });
      if (
        !found ||
        found.result.attempt !== input.attempt ||
        found.result.providerRequestId !== input.providerRequestId ||
        found.result.status !== 'submitted'
      )
        return Result.Ok({ type: 'result_attempt_superseded' });
      if (!checkpoints.has(input.resultId))
        checkpoints.set(input.resultId, input.checkpoint);
      return Result.Ok({
        type: 'result_output_saved',
        checkpoint: checkpoints.get(input.resultId)!,
      });
    },
    async retryAttempt(input) {
      const found = findResult(input.resultId);
      if (
        !found ||
        found.result.attempt !== input.expectedAttempt ||
        !isRenderRetryable(found.result, input.expiredBeforeMs)
      )
        return Result.Ok({ type: 'result_attempt_superseded' });
      const cleanupId = checkpoints.get(input.resultId)?.objectKey ?? null;
      accountingIdentities.delete(input.resultId);
      Object.assign(found.result, {
        status: 'pending',
        attempt: input.expectedAttempt + 1,
        attemptStartedAt: input.startedAt,
        providerRequestId: null,
        outputImageId: null,
        errorMessage: null,
        submittedAt: null,
        completedAt: null,
        costUsdMicros: null,
        costSource: null,
        modelVersion: null,
        framingChanged: false,
      });
      owners.delete(input.resultId);
      checkpoints.delete(input.resultId);
      return Result.Ok({
        type: 'result_retry_claimed',
        attempt: found.result.attempt,
        cleanupId,
      });
    },
    async failResultAttempt(input) {
      const found = findResult(input.resultId);
      if (
        !found ||
        found.result.attempt !== input.attempt ||
        owners.get(input.resultId) !== input.workflowRunId ||
        (input.providerRequestId === undefined &&
          ((found.result.status !== 'pending' &&
            found.result.status !== 'failed') ||
            found.result.providerRequestId !== null)) ||
        (input.providerRequestId !== undefined &&
          found.result.providerRequestId !== input.providerRequestId &&
          !(
            input.submissionPersistenceFailure &&
            (found.result.status === 'pending' ||
              found.result.status === 'failed') &&
            found.result.providerRequestId === null
          ))
      )
        return Result.Ok({ type: 'result_attempt_superseded' });
      if (found.result.status === 'failed')
        return Result.Ok({
          type:
            found.result.errorMessage === input.reason.slice(0, 500)
              ? 'result_marked_failed'
              : 'result_attempt_superseded',
        });
      if (
        found.result.status !== 'pending' &&
        found.result.status !== 'submitted'
      )
        return Result.Ok({ type: 'result_attempt_superseded' });
      const checkpoint = checkpoints.get(input.resultId);
      if (checkpoint)
        checkpoints.set(input.resultId, {
          ...checkpoint,
          source: { kind: 'retired' },
        });
      Object.assign(found.result, {
        status: 'failed',
        errorMessage: input.reason.slice(0, 500),
        completedAt: input.now,
      });
      return Result.Ok({ type: 'result_marked_failed' });
    },
    async publicationContext(resultId) {
      const found = findResult(resultId);
      return Result.Ok(
        found
          ? {
              type: 'publication_context',
              context: {
                result: structuredClone(found.result),
                designId: found.render.designId,
                renderSourceImageId: found.render.renderSourceImageId,
                workflowRunId: owners.get(resultId) ?? null,
                checkpoint: checkpoints.get(resultId) ?? null,
                accountingIdentity: accountingIdentities.get(resultId) ?? null,
                sourceSize: found.render.recipe.source,
              },
            }
          : { type: 'result_not_found' }
      );
    },
    async completeResultAttempt(input) {
      const found = findResult(input.resultId);
      if (
        !found ||
        found.result.attempt !== input.attempt ||
        found.result.providerRequestId !== input.providerRequestId ||
        found.result.status !== 'submitted'
      )
        return Result.Ok({ type: 'result_attempt_superseded' });
      const checkpoint = checkpoints.get(input.resultId);
      if (checkpoint)
        checkpoints.set(input.resultId, {
          ...checkpoint,
          source: { kind: 'retired' },
        });
      Object.assign(found.result, input.completion, {
        status: 'succeeded',
        outputImageId: input.imageId,
      });
      return Result.Ok({ type: 'result_completed' });
    },
    async referencedOutputKeys(keys) {
      return Result.Ok({
        type: 'referenced_output_keys',
        keys: keys.filter((key) =>
          [...checkpoints.values()].some(
            (checkpoint) => checkpoint.objectKey === key
          )
        ),
      });
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
  return { repository, drafts, renders, owners, checkpoints };
};
