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
  BackgroundRemovalScheduler,
  BackgroundRemover,
} from '../ports/background-remover';
import type { DesignAccess } from '../ports/design-access';
import type { ItemRepository } from '../ports/item-repository';

export type MoodboardUseCaseDeps = {
  itemRepository: ItemRepository;
  designAccess: DesignAccess;
  uploadIntentStore: UploadIntentStore;
  objectStorage: ObjectStoragePort;
  permissionChecker: PermissionChecker;
  backgroundRemovalScheduler: BackgroundRemovalScheduler;
  idGenerator: IdGenerator;
  clock: Clock;
  logger: Logger;
};

export type MoodboardPipelineDeps = {
  itemRepository: ItemRepository;
  designAccess: DesignAccess;
  objectStorage: ObjectStoragePort;
  backgroundRemover: BackgroundRemover;
  providerCallLog: ProviderCallLog;
  idGenerator: IdGenerator;
  clock: Clock;
  logger: Logger;
};

export type MoodboardForbidden = { type: 'moodboard_forbidden' };
export type MoodboardDesignNotFound = { type: 'design_not_found' };

export type MoodboardResult<T> = ApplicationResult<T>;

export const SIGNED_ITEM_URL_SECONDS = 60 * 60;
