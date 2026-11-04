import { Result } from '@bloodyowl/boxed';

import {
  type DesignId,
  toItemId,
  toItemVersionId,
} from '@/modules/kernel/domain/ids';

import { scheduleCutoutAttempt } from './schedule-cutout-attempt';
import type { MoodboardResult, MoodboardUseCaseDeps } from './types';

/**
 * Copy a design's items into another design (revised architect image).
 * Copies reuse the same immutable image objects; returns old → new item ids.
 */
export async function copyItems(
  deps: Pick<
    MoodboardUseCaseDeps,
    | 'itemRepository'
    | 'idGenerator'
    | 'backgroundRemovalScheduler'
    | 'logger'
    | 'clock'
  >,
  input: { fromDesignId: DesignId; toDesignId: DesignId }
): Promise<
  MoodboardResult<{ type: 'items_copied'; itemIds: Record<string, string> }>
> {
  const listed = await deps.itemRepository.listByDesign(input.fromDesignId);
  if (listed.isError()) return Result.Error(listed.getError());
  const itemIds: Record<string, string> = {};
  for (const item of listed.get().items) {
    const rawItemId = deps.idGenerator.createId();
    if (rawItemId.isError()) return Result.Error(rawItemId.getError());
    const rawVersionId = deps.idGenerator.createId();
    if (rawVersionId.isError()) return Result.Error(rawVersionId.getError());
    const id = toItemId(rawItemId.get());
    const versionId = toItemVersionId(rawVersionId.get());
    if (id.isError()) return Result.Error(id.getError());
    if (versionId.isError()) return Result.Error(versionId.getError());
    const version = item.currentVersion;
    let attemptId: string | undefined;
    if (version.cutoutStatus === 'pending') {
      const attempt = deps.idGenerator.createId();
      if (attempt.isError()) return Result.Error(attempt.getError());
      attemptId = attempt.get();
    }
    // oxlint-disable-next-line no-await-in-loop -- a mood board is small; keeps order.
    const created = await deps.itemRepository.create({
      id: id.get(),
      designId: input.toDesignId,
      kind: item.kind,
      name: item.name,
      category: item.category,
      vendor: item.vendor,
      productUrl: item.productUrl,
      version: {
        id: versionId.get(),
        photo: version.photo,
        cutoutKey: attemptId ? null : version.cutoutKey,
        maskKey: attemptId ? null : version.maskKey,
        cutoutStatus: version.cutoutStatus,
        ...(attemptId
          ? { cutoutAttempt: { id: attemptId, startedAt: deps.clock.now() } }
          : {}),
      },
    });
    if (created.isError()) return Result.Error(created.getError());
    itemIds[item.id] = id.get();
    if (attemptId) {
      // oxlint-disable-next-line no-await-in-loop -- the copy must be saved before starting its workflow.
      const started = await scheduleCutoutAttempt(
        deps,
        { itemVersionId: versionId.get(), attemptId },
        'keep_copy'
      );
      if (started.isError()) return Result.Error(started.getError());
    }
  }
  return Result.Ok({ type: 'items_copied', itemIds });
}
