import { Result } from '@bloodyowl/boxed';

import {
  type ObjectKey,
  toObjectKey,
  type UserId,
} from '@/modules/kernel/domain/ids';
import {
  createUploadObjectKey,
  type UploadPurpose,
} from '@/modules/kernel/domain/upload-policy';

import { checkDesignPermission } from './design-access';
import type { DesignResult, DesignUseCaseDeps } from './types';

/** How long a presigned upload may wait before it is registered. */
export const UPLOAD_INTENT_TTL_MS = 30 * 60 * 1000;

export type PrepareDesignUploadInput = {
  currentUserId: UserId;
  purpose: UploadPurpose;
  fileType: string;
};

export type DesignUploadOutcome =
  | { type: 'design_upload_prepared'; objectKey: ObjectKey }
  | { type: 'design_upload_forbidden' }
  | { type: 'design_upload_invalid_file_type' };

/**
 * Issue a server-decided object key for a presigned upload and remember it as
 * an upload intent bound to the caller and purpose.
 */
export async function prepareDesignUpload(
  deps: DesignUseCaseDeps,
  input: PrepareDesignUploadInput
): Promise<DesignResult<DesignUploadOutcome>> {
  const access = await checkDesignPermission(
    deps,
    input.currentUserId,
    'create'
  );
  if (access.isError()) return Result.Error(access.getError());
  if (access.get().type === 'forbidden') {
    return Result.Ok({ type: 'design_upload_forbidden' });
  }

  const id = deps.idGenerator.createId();
  if (id.isError()) return Result.Error(id.getError());
  const key = createUploadObjectKey({
    purpose: input.purpose,
    id: id.get(),
    fileType: input.fileType,
  });
  if (key.isError()) {
    return Result.Ok({ type: 'design_upload_invalid_file_type' });
  }
  const objectKey = toObjectKey(key.get());
  if (objectKey.isError()) return Result.Error(objectKey.getError());

  const remembered = await deps.uploadIntentStore.remember({
    objectKey: objectKey.get(),
    userId: input.currentUserId,
    purpose: input.purpose,
    contentType: input.fileType.trim().toLowerCase(),
    expiresAt: new Date(deps.clock.now().getTime() + UPLOAD_INTENT_TTL_MS),
  });
  if (remembered.isError()) return Result.Error(remembered.getError());

  return Result.Ok({
    type: 'design_upload_prepared',
    objectKey: objectKey.get(),
  });
}
