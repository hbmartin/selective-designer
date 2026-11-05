import { Result } from '@bloodyowl/boxed';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  DesignCreatedOutcome,
  DesignRepository,
  NewDesignImage,
} from '@/modules/design';
import { createDesignRepository } from '@/modules/design/backend';
import { AppError, type ApplicationResult } from '@/modules/kernel';
import { createTransactionRunner } from '@/modules/kernel/backend';
import { safeErrorDiagnostics } from '@/modules/kernel/domain/errors/safe-error-diagnostics';
import { type DesignId, toImageId } from '@/modules/kernel/domain/ids';
import { classifyDatabaseFailure } from '@/modules/kernel/infrastructure/db/db-error-details';
import type {
  DbLike,
  DbTransaction,
} from '@/modules/kernel/infrastructure/db/types';
import type {
  RegisteredResultImage,
  RenderAttemptIdentity,
  RenderCompletion,
} from '@/modules/rendering';
import { createRenderRepository } from '@/modules/rendering/backend';
import {
  DETECTION_START_WINDOW_MS,
  newDetectionProgress,
} from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/backend';

import type { PipelineKernel } from './pipeline-kernel';

const RETRY_DELAYS = [100, 300] as const;
type ExpectedImage = NewDesignImage & { designId: DesignId };
type WriteKernel = Pick<
  PipelineKernel,
  'db' | 'clock' | 'idGenerator' | 'logger'
>;
type Options = { delay?: (ms: number) => Promise<unknown> };
type Registered =
  | RegisteredResultImage
  | { type: 'result_image_not_registered' }
  | { type: 'result_attempt_superseded' };

const writeError = (cause: unknown) =>
  cause instanceof AppError
    ? cause
    : new AppError({
        code: 'IMAGE_DETECTION_WRITE_FAILED',
        category: 'system',
        status: 500,
        message: 'Could not save the image and its detection intent',
        cause,
      });
const integrityError = () =>
  new AppError({
    code: 'IMAGE_REGISTRATION_MISMATCH',
    category: 'system',
    status: 500,
    message: 'The saved image does not match its registration',
  });

const isExpectedImage = (actual: ExpectedImage, expected: ExpectedImage) =>
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

/** Internal transaction primitive; public writers below own all persistence inputs. */
async function recoverWrite<T>(
  kernel: WriteKernel,
  input: {
    image: ExpectedImage;
    writeId: string;
    work: (tx: DbTransaction) => Promise<ApplicationResult<T>>;
    verify?: (tx: DbTransaction) => Promise<boolean>;
  },
  options: Options
): Promise<ApplicationResult<T>> {
  const wait = options.delay ?? delay;
  const runner = createTransactionRunner(kernel.db);
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    let candidate: { value: T } | undefined;
    try {
      // oxlint-disable-next-line no-await-in-loop -- retry the entire confirmed rollback.
      return await runner.run(async (tx) => {
        const written = await input.work(tx);
        if (written.isError()) throw written.getError();
        candidate = { value: written.get() };
        return written;
      });
    } catch (cause) {
      const failure = classifyDatabaseFailure(cause);
      if (failure.retryableRollback && attempt < RETRY_DELAYS.length) {
        // oxlint-disable-next-line no-await-in-loop -- bounded transaction backoff.
        await wait(RETRY_DELAYS[attempt]!);
        continue;
      }
      if (failure.publication === 'unknown' && candidate) {
        for (let read = 0; read <= RETRY_DELAYS.length; read++) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- coherent reconciliation snapshot.
            const matched = await runner.run(
              async (tx) => {
                const [found, identity] = await Promise.all([
                  createDesignRepository({ db: tx }).findImage(input.image.id),
                  createRegionRepository({ db: tx }).matchImageWrite(
                    input.image.id,
                    input.writeId
                  ),
                ]);
                if (found.isError()) throw found.getError();
                if (identity.isError()) throw identity.getError();
                const image = found.get();
                return (
                  image.type === 'image_found' &&
                  identity.get().type === 'image_write_matched' &&
                  isExpectedImage(image.image, input.image) &&
                  (!input.verify || (await input.verify(tx)))
                );
              },
              { isolationLevel: 'repeatable read', accessMode: 'read only' }
            );
            if (matched) return Result.Ok(candidate.value);
          } catch (error) {
            kernel.logger.warn({
              event: 'image.write.reconciliation_failed',
              details: {
                imageId: input.image.id,
                read: read + 1,
                ...safeErrorDiagnostics(error),
              },
            });
          }
          if (read < RETRY_DELAYS.length) {
            // oxlint-disable-next-line no-await-in-loop -- bounded reconciliation, never blind writes.
            await wait(RETRY_DELAYS[read]!);
          }
        }
        kernel.logger.warn({
          event: 'image.write.unresolved',
          details: {
            imageId: input.image.id,
            ...safeErrorDiagnostics(cause),
          },
        });
      }
      return Result.Error(writeError(cause));
    }
  }
  return Result.Error(writeError(undefined));
}

async function startIntent(
  tx: DbTransaction,
  input: {
    image: ExpectedImage;
    writeId: string;
    copying: boolean;
    carryFromImageId: ExpectedImage['id'] | null;
    now: Date;
  }
) {
  const started = await createRegionRepository({ db: tx }).startDetection({
    imageId: input.image.id,
    runId: input.writeId,
    imageWriteId: input.writeId,
    expiresAtMs: input.now.getTime() + DETECTION_START_WINDOW_MS,
    phase: input.copying ? 'copying' : 'ready',
    progress: newDetectionProgress(input.carryFromImageId),
  });
  if (started.isError()) throw started.getError();
  if (started.get().type !== 'detection_started') throw integrityError();
}

/** One input supplies both the saved base image and its detection intent. */
export function writeImageWithDetection(
  kernel: WriteKernel,
  input: Parameters<DesignRepository['create']>[0],
  options: Options = {}
): Promise<ApplicationResult<DesignCreatedOutcome>> {
  const id = kernel.idGenerator.createId();
  if (id.isError()) return Promise.resolve(Result.Error(id.getError()));
  const image = { ...input.baseImage, designId: input.id };
  const now = kernel.clock.now();
  return recoverWrite(
    kernel,
    {
      image,
      writeId: id.get(),
      work: async (tx) => {
        const saved = await createDesignRepository({ db: tx }).create(input);
        if (saved.isError()) return Result.Error(saved.getError());
        if (!isExpectedImage(saved.get().design.baseImage, image))
          throw integrityError();
        await startIntent(tx, {
          image,
          writeId: id.get(),
          copying: input.copiedFromDesignId !== null,
          carryFromImageId: null,
          now,
        });
        return saved;
      },
    },
    options
  );
}

export const renderImageIdentity = (input: RenderAttemptIdentity) => {
  const imageId = toImageId(
    `render-result:${input.resultId}:attempt:${input.attempt}`
  );
  if (imageId.isError()) throw imageId.getError();
  return {
    imageId: imageId.get(),
    writeId: `render-image-write:${input.resultId}:attempt:${input.attempt}`,
  };
};

/** Lookup also works after process loss; the result link committed with the image. */
export async function findRegisteredRenderImage(
  kernel: { db: DbLike },
  input: RenderAttemptIdentity
): Promise<ApplicationResult<Registered>> {
  const found = await createRenderRepository({
    db: kernel.db,
  }).publicationContext(input.resultId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'result_not_found')
    return Result.Ok({ type: 'result_attempt_superseded' });
  const { result, designId } = outcome.context;
  if (
    result.attempt !== input.attempt ||
    result.providerRequestId !== input.providerRequestId
  )
    return Result.Ok({ type: 'result_attempt_superseded' });
  if (result.status !== 'succeeded')
    return Result.Ok({ type: 'result_image_not_registered' });
  if (!result.outputImageId) return Result.Error(integrityError());
  const image = await createDesignRepository({ db: kernel.db }).findImage(
    result.outputImageId
  );
  if (image.isError()) return Result.Error(image.getError());
  const saved = image.get();
  if (
    saved.type !== 'image_found' ||
    saved.image.kind !== 'result' ||
    saved.image.designId !== designId
  )
    return Result.Error(integrityError());
  const identity = renderImageIdentity(input);
  if (result.outputImageId === identity.imageId) {
    const matched = await createRegionRepository({
      db: kernel.db,
    }).matchImageWrite(identity.imageId, identity.writeId);
    if (matched.isError()) return Result.Error(matched.getError());
    if (matched.get().type !== 'image_write_matched')
      return Result.Error(integrityError());
  }
  return Result.Ok({
    type: 'result_image_registered',
    imageId: saved.image.id,
    width: saved.image.working.width,
    height: saved.image.working.height,
  });
}

/** Publish a current render attempt, image and intent under the same row lock. */
export function writeRenderImageWithDetection(
  kernel: WriteKernel,
  input: RenderAttemptIdentity & {
    designId: DesignId;
    image: Omit<NewDesignImage, 'id'>;
    carryFromImageId: ExpectedImage['id'];
    completion: RenderCompletion;
  },
  options: Options = {}
): Promise<
  ApplicationResult<
    RegisteredResultImage | { type: 'result_attempt_superseded' }
  >
> {
  const identity = renderImageIdentity(input);
  const image = {
    ...input.image,
    id: identity.imageId,
    designId: input.designId,
  };
  const now = kernel.clock.now();
  return recoverWrite(
    kernel,
    {
      image,
      writeId: identity.writeId,
      verify: async (tx) => {
        const saved = await createRenderRepository({
          db: tx,
        }).publicationContext(input.resultId);
        if (saved.isError()) throw saved.getError();
        const value = saved.get();
        return (
          value.type === 'publication_context' &&
          value.context.result.attempt === input.attempt &&
          value.context.result.providerRequestId === input.providerRequestId &&
          value.context.result.status === 'succeeded' &&
          value.context.result.outputImageId === image.id
        );
      },
      work: async (tx) => {
        const renders = createRenderRepository({ db: tx });
        const locked = await renders.publicationContext(
          input.resultId,
          'update'
        );
        if (locked.isError()) return Result.Error(locked.getError());
        const lockedValue = locked.get();
        if (lockedValue.type === 'result_not_found')
          return Result.Ok({ type: 'result_attempt_superseded' });
        const row = lockedValue.context;
        if (
          row.result.attempt !== input.attempt ||
          row.result.providerRequestId !== input.providerRequestId
        )
          return Result.Ok({ type: 'result_attempt_superseded' });
        if (row.result.status === 'succeeded') {
          const existing = await findRegisteredRenderImage({ db: tx }, input);
          if (existing.isError()) return Result.Error(existing.getError());
          const saved = existing.get();
          if (saved.type === 'result_image_not_registered')
            return Result.Error(integrityError());
          return Result.Ok(saved);
        }
        if (row.result.status !== 'submitted')
          return Result.Ok({ type: 'result_attempt_superseded' });
        if (
          row.designId !== input.designId ||
          row.renderSourceImageId !== input.carryFromImageId
        )
          return Result.Error(integrityError());
        const added = await createDesignRepository({ db: tx }).addImage({
          designId: input.designId,
          image,
        });
        if (added.isError()) return Result.Error(added.getError());
        if (!isExpectedImage(added.get().image, image)) throw integrityError();
        await startIntent(tx, {
          image,
          writeId: identity.writeId,
          copying: false,
          carryFromImageId: input.carryFromImageId,
          now,
        });
        const completed = await renders.completeResultAttempt({
          ...input,
          imageId: image.id,
        });
        if (completed.isError()) return Result.Error(completed.getError());
        if (completed.get().type !== 'result_completed') throw integrityError();
        return Result.Ok({
          type: 'result_image_registered',
          imageId: image.id,
          width: image.working.width,
          height: image.working.height,
        });
      },
    },
    options
  );
}
