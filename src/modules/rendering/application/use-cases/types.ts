import type {
  ApplicationResult,
  Clock,
  IdGenerator,
  Logger,
  ObjectStoragePort,
  PermissionChecker,
  ProviderCallLog,
} from '@/modules/kernel';

import type {
  ImageModels,
  MaskCompositor,
  RenderInputs,
  RenderRepository,
  RenderScheduler,
  ResultImages,
} from '../ports/ports';

export type RenderingUseCaseDeps = {
  renderRepository: RenderRepository;
  renderInputs: RenderInputs;
  maskCompositor: MaskCompositor;
  renderScheduler: RenderScheduler;
  permissionChecker: PermissionChecker;
  objectStorage: ObjectStoragePort;
  /** Model ids enabled by configuration, in display order. */
  enabledModelIds: readonly string[];
  idGenerator: IdGenerator;
  clock: Clock;
  logger: Logger;
};

export type RenderingPipelineDeps = {
  renderRepository: RenderRepository;
  renderInputs: RenderInputs;
  maskCompositor: MaskCompositor;
  imageModels: ImageModels;
  resultImages: ResultImages;
  objectStorage: ObjectStoragePort;
  providerCallLog: ProviderCallLog;
  idGenerator: IdGenerator;
  clock: Clock;
  logger: Logger;
};

export type RenderingResult<T> = ApplicationResult<T>;
export type RenderingForbidden = { type: 'rendering_forbidden' };
export type ImageNotFound = { type: 'image_not_found' };

/** Signed input URLs must outlive queueing at the provider. */
export const PROVIDER_INPUT_URL_SECONDS = 6 * 60 * 60;
export const SIGNED_VIEW_URL_SECONDS = 60 * 60;
