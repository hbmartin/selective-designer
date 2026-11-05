import { Result } from '@bloodyowl/boxed';
import { setTimeout as delay } from 'node:timers/promises';

import type { DesignRepository, NewDesignImage } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/backend';
import { AppError, type ApplicationResult } from '@/modules/kernel';
import { createTransactionRunner } from '@/modules/kernel/backend';
import type { DesignId } from '@/modules/kernel/domain/ids';
import {
  DETECTION_START_WINDOW_MS,
  newDetectionProgress,
} from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/backend';

import type { PipelineKernel } from './pipeline-kernel';

const RETRY_DELAYS = [100, 300] as const;
const RETRYABLE_ROLLBACKS = new Set(['40001', '40P01', '55P03']);

// Adapters wrap driver errors. Inspect their cause chain without losing the
// original diagnostic or treating transport failures as confirmed rollbacks.
const sqlStateOf = (error: unknown): string | undefined => {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      /^(?:[0-9]{2}|0[A-Z]|[FP][0-9]|HV|XX)[0-9A-Z]{3}$/u.test(current.code)
    )
      return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
};

type ExpectedImage = NewDesignImage & { designId: DesignId };
type WriteKernel = Pick<PipelineKernel, 'db' | 'clock' | 'idGenerator'>;

const isExpectedImage = (
  actual: NewDesignImage & { designId: DesignId },
  expected: ExpectedImage
) =>
  actual.id === expected.id &&
  actual.designId === expected.designId &&
  actual.kind === expected.kind &&
  actual.originalKey === expected.originalKey &&
  actual.originalContentType === expected.originalContentType &&
  actual.workingKey === expected.workingKey &&
  actual.original.width === expected.original.width &&
  actual.original.height === expected.original.height &&
  actual.working.width === expected.working.width &&
  actual.working.height === expected.working.height;

/** Publish the image and its intent atomically; reconcile a lost commit response. */
export async function writeImageWithDetection<T>(
  kernel: WriteKernel,
  input: {
    waitingForCopy?: boolean;
    carryFromImageId: ExpectedImage['id'] | null;
    image: ExpectedImage;
    save: (design: DesignRepository) => Promise<ApplicationResult<T>>;
  },
  options: { delay?: (ms: number) => Promise<unknown> } = {}
): Promise<ApplicationResult<T>> {
  const id = kernel.idGenerator.createId();
  if (id.isError()) return Result.Error(id.getError());
  const wait = options.delay ?? delay;
  const runner = createTransactionRunner(kernel.db);
  const now = kernel.clock.now();

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    let committedCandidate: { value: T } | undefined;
    try {
      // oxlint-disable-next-line no-await-in-loop -- retry the entire rolled-back transaction.
      return await runner.run(async (tx) => {
        const written = await input.save(createDesignRepository({ db: tx }));
        if (written.isError()) throw written.getError();
        const intent = await createRegionRepository({ db: tx }).startDetection({
          imageId: input.image.id,
          runId: id.get(),
          imageWriteId: id.get(),
          expiresAtMs: now.getTime() + DETECTION_START_WINDOW_MS,
          phase: input.waitingForCopy ? 'copying' : 'ready',
          progress: newDetectionProgress(input.carryFromImageId),
        });
        if (intent.isError()) throw intent.getError();
        if (intent.get().type !== 'detection_started') {
          throw new AppError({
            code: 'IMAGE_DETECTION_INTENT_CONFLICT',
            category: 'system',
            status: 500,
            message: 'An intent already exists for the new image',
          });
        }
        committedCandidate = { value: written.get() };
        return written;
      });
    } catch (cause) {
      const state = sqlStateOf(cause);
      if (
        state &&
        RETRYABLE_ROLLBACKS.has(state) &&
        attempt < RETRY_DELAYS.length
      ) {
        // oxlint-disable-next-line no-await-in-loop -- bounded backoff after a confirmed rollback.
        await wait(RETRY_DELAYS[attempt]!);
        continue;
      }
      const uncertain =
        !state ||
        state.startsWith('08') ||
        ['40003', '57P01', '57P02', '57P03'].includes(state);
      if (uncertain && committedCandidate) {
        for (let read = 0; read <= RETRY_DELAYS.length; read++) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- one coherent snapshot for reconciliation.
            const matched = await runner.run(
              async (tx) => {
                const [found, identity] = await Promise.all([
                  createDesignRepository({ db: tx }).findImage(input.image.id),
                  createRegionRepository({ db: tx }).matchImageWrite(
                    input.image.id,
                    id.get()
                  ),
                ]);
                if (found.isError()) throw found.getError();
                if (identity.isError()) throw identity.getError();
                const image = found.get();
                return (
                  image.type === 'image_found' &&
                  identity.get().type === 'image_write_matched' &&
                  isExpectedImage(image.image, input.image)
                );
              },
              { isolationLevel: 'repeatable read', accessMode: 'read only' }
            );
            if (matched) return Result.Ok(committedCandidate.value);
          } catch {
            // Preserve the original write failure if reconciliation is unavailable.
          }
          if (read < RETRY_DELAYS.length) {
            // oxlint-disable-next-line no-await-in-loop -- bounded reconciliation reads, never blind writes.
            await wait(RETRY_DELAYS[read]!);
          }
        }
      }
      return Result.Error(
        cause instanceof AppError
          ? cause
          : new AppError({
              code: 'IMAGE_DETECTION_WRITE_FAILED',
              category: 'system',
              status: 500,
              message: 'Could not save the image and its detection intent',
              cause,
            })
      );
    }
  }
  // The bounded loop returns success or the final failure on every path.
  return Result.Error(
    new AppError({
      code: 'IMAGE_DETECTION_WRITE_FAILED',
      category: 'system',
      status: 500,
    })
  );
}
