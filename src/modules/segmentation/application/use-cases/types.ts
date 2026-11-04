import type {
  ApplicationResult,
  Clock,
  IdGenerator,
  Logger,
  ObjectStoragePort,
  PermissionChecker,
  ProviderCallLog,
  UploadIntentStore,
} from '@/modules/kernel';

import type {
  ConceptSource,
  DetectionRetry,
  ImageAccess,
  RegionRepository,
  Segmenter,
} from '../ports/ports';

export type SegmentationPipelineDeps = {
  regionRepository: RegionRepository;
  imageAccess: ImageAccess;
  conceptSource: ConceptSource;
  segmenter: Segmenter;
  objectStorage: ObjectStoragePort;
  providerCallLog: ProviderCallLog;
  idGenerator: IdGenerator;
  clock: Clock;
  logger: Logger;
};

export type SegmentationUseCaseDeps = Omit<
  SegmentationPipelineDeps,
  'conceptSource'
> & {
  detectionRetry: DetectionRetry;
  uploadIntentStore: UploadIntentStore;
  permissionChecker: PermissionChecker;
};

export type SegmentationResultOf<T> = ApplicationResult<T>;
export const SIGNED_MASK_URL_SECONDS = 60 * 60;

export const DETECTION_LEASE_MS = 30 * 60 * 1000;
