import { Result } from '@bloodyowl/boxed';

import type { DesignRepository } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/backend';
import { AppError, type ApplicationResult } from '@/modules/kernel';
import { createTransactionRunner } from '@/modules/kernel/backend';
import type { ImageId } from '@/modules/kernel/domain/ids';
import {
  DETECTION_START_WINDOW_MS,
  newDetectionProgress,
} from '@/modules/segmentation';
import { createRegionRepository } from '@/modules/segmentation/backend';

import type { PipelineKernel } from './pipeline-kernel';

/** Publish the image and its detection intent together before queue dispatch. */
export async function writeImageWithDetection<T>(
  kernel: Pick<PipelineKernel, 'db' | 'clock' | 'idGenerator'>,
  input: {
    waitingForCopy?: boolean;
    carryFromImageId: ImageId | null;
    save: (design: DesignRepository) => Promise<ApplicationResult<T>>;
    imageId: (saved: T) => ImageId;
  }
): Promise<ApplicationResult<T>> {
  const id = kernel.idGenerator.createId();
  if (id.isError()) return Result.Error(id.getError());
  try {
    return await createTransactionRunner(kernel.db).run(async (tx) => {
      const written = await input.save(createDesignRepository({ db: tx }));
      if (written.isError()) throw written.getError();
      const intent = await createRegionRepository({ db: tx }).startDetection({
        imageId: input.imageId(written.get()),
        runId: id.get(),
        expiresAtMs: kernel.clock.now().getTime() + DETECTION_START_WINDOW_MS,
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
      return written;
    });
  } catch (cause) {
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
