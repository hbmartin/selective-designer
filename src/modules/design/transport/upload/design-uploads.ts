import { Result } from '@bloodyowl/boxed';
import { match, P } from 'ts-pattern';

import type { AuthSession } from '@/modules/auth';
import {
  IMMUTABLE_OBJECT_CACHE_CONTROL,
  type Logger,
  type ObjectUploadPrepared,
  type ObjectUploadRouteDefinition,
  type UploadPurpose,
  uploadPurposePolicies,
  UploadRejectedError,
} from '@/modules/kernel';
import type { TelemetryAdapter } from '@/platform/telemetry';

import type { DesignUseCases } from '../../factory';

export type DesignUploadDeps = {
  getCurrentSession: (headers: Headers) => Promise<AuthSession | null>;
  getUseCases: () => Pick<DesignUseCases, 'prepareUpload'>;
  telemetry: Pick<TelemetryAdapter, 'startSpan'>;
  logger?: Pick<Logger, 'warn'>;
};

/** Translation-key prefix for upload rejections (rendered by the client). */
export const designUploadErrorKeyPrefix = 'design:upload.errors.';

type RejectionKey = 'NOT_AUTHENTICATED' | 'UNAUTHORIZED' | 'invalid_file_type';

const reject = (
  deps: Pick<DesignUploadDeps, 'logger'>,
  key: RejectionKey,
  purpose: UploadPurpose,
  fileType: string
): Result<never, UploadRejectedError> => {
  deps.logger?.warn({
    event: 'security.upload_rejected',
    details: { fileType, purpose, reason: key },
  });
  return Result.Error(
    new UploadRejectedError(`${designUploadErrorKeyPrefix}${key}`)
  );
};

const prepare = (
  deps: DesignUploadDeps,
  purpose: UploadPurpose,
  input: { headers: Headers; fileType: string }
): Promise<Result<ObjectUploadPrepared, UploadRejectedError>> =>
  deps.telemetry.startSpan(
    {
      attributes: {
        'file.mime_type': input.fileType,
        'operation.name': 'design.upload.beforeUpload',
        'operation.type': 'upload_hook',
        'upload.route': purpose,
      },
      name: 'design.upload.beforeUpload',
      op: 'upload.before_upload',
    },
    async () => {
      const session = await deps.getCurrentSession(input.headers);
      if (!session?.user) {
        return reject(deps, 'NOT_AUTHENTICATED', purpose, input.fileType);
      }
      const prepared = await deps.getUseCases().prepareUpload({
        currentUserId: session.user.id,
        purpose,
        fileType: input.fileType,
      });
      return match(prepared)
        .with(Result.P.Error(P.select()), (error) => {
          // A system failure, not a rejection: let it propagate.
          throw error;
        })
        .with(
          Result.P.Ok({
            type: 'design_upload_prepared',
            objectKey: P.select(),
          }),
          (objectKey): Result<ObjectUploadPrepared, UploadRejectedError> =>
            Result.Ok({
              objectKey,
              cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
            })
        )
        .with(Result.P.Ok({ type: 'design_upload_forbidden' }), () =>
          reject(deps, 'UNAUTHORIZED', purpose, input.fileType)
        )
        .with(Result.P.Ok({ type: 'design_upload_invalid_file_type' }), () =>
          reject(deps, 'invalid_file_type', purpose, input.fileType)
        )
        .exhaustive();
    }
  );

/** One presigned-upload route per purpose, keyed by the purpose name. */
export const designUploadRouteDefinitions = (
  deps: DesignUploadDeps,
  purposes: readonly UploadPurpose[]
): Record<string, ObjectUploadRouteDefinition> =>
  Object.fromEntries(
    purposes.map((purpose) => {
      const policy = uploadPurposePolicies[purpose];
      return [
        purpose,
        {
          fileTypes: [...policy.acceptedFileTypes],
          maxFileSize: policy.maxFileSizeBytes,
          prepare: (ctx: { headers: Headers; fileType: string }) =>
            prepare(deps, purpose, ctx),
        },
      ] as const;
    })
  );
