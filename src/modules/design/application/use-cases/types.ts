import type {
  ApplicationResult,
  Clock,
  IdGenerator,
  Logger,
  ObjectStoragePort,
  PermissionChecker,
  UploadIntentStore,
} from '@/modules/kernel';

import type { DesignCopiedListener } from '../ports/design-copied-listener';
import type { DesignRepository } from '../ports/design-repository';
import type { ImageArrivedListener } from '../ports/image-arrived-listener';

export type DesignUseCaseDeps = {
  designRepository: DesignRepository;
  writeDesignWithBaseImage: DesignRepository['create'];
  uploadIntentStore: UploadIntentStore;
  objectStorage: ObjectStoragePort;
  permissionChecker: PermissionChecker;
  idGenerator: IdGenerator;
  clock: Clock;
  logger: Logger;
  imageArrivedListener: ImageArrivedListener;
  designCopiedListener: DesignCopiedListener;
};

/** Pipeline use cases run inside workflow steps: no request, no permission. */
export type DesignPipelineDeps = Pick<
  DesignUseCaseDeps,
  'designRepository' | 'objectStorage' | 'idGenerator' | 'logger'
>;

export type DesignForbiddenOutcome = { type: 'design_forbidden' };

export type DesignResult<TOutcome> = ApplicationResult<TOutcome>;

/** Signed URLs live this long; Query `staleTime` must stay below it. */
export const SIGNED_IMAGE_URL_SECONDS = 60 * 60;
