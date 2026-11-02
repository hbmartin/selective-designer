import {
  handleRequest,
  RejectUpload,
  route,
  type Router,
} from '@better-upload/server';
import { custom } from '@better-upload/server/clients';
import { Result } from '@bloodyowl/boxed';
import { mapValues } from 'remeda';

import type {
  ObjectDeleteOutcome,
  ObjectStoragePort,
  ObjectUploadRequestHandler,
  ObjectUploadRouteDefinition,
} from '@/modules/kernel/application/ports/object-storage';
import type { ApplicationResult } from '@/modules/kernel/application/result';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { getStorageConfig } from '@/modules/kernel/infrastructure/config/storage';

const OBJECT_DELETE_TIMEOUT_MS = 5_000;

const createUploadClient = () => {
  const config = getStorageConfig();
  return custom({
    host: config.host,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    secure: config.secure,
  });
};

const toBetterUploadRoute = (definition: ObjectUploadRouteDefinition) =>
  route({
    fileTypes: definition.fileTypes,
    maxFileSize: definition.maxFileSize,
    onBeforeUpload: async ({ req, file }) => {
      const prepared = await definition.prepare({
        headers: req.headers,
        fileType: file.type,
      });
      // Map the provider-neutral rejection to better-upload's mechanism. This
      // adapter is the single seam that speaks the SDK's exception dialect;
      // genuine system failures reject the promise above and propagate.
      if (prepared.isError()) {
        throw new RejectUpload(prepared.getError().messageKey);
      }
      const objectInfo = prepared.get();
      return {
        objectInfo: {
          key: objectInfo.objectKey,
          ...(objectInfo.cacheControl
            ? { cacheControl: objectInfo.cacheControl }
            : {}),
        },
      };
    },
  });

/**
 * better-upload (+ S3-compatible) implementation of {@link ObjectStoragePort}.
 * This adapter is the ONLY place allowed to import `@better-upload/server`.
 */
export class BetterUploadObjectStorage implements ObjectStoragePort {
  createUploadRequestHandler(
    routes: Record<string, ObjectUploadRouteDefinition>
  ): ObjectUploadRequestHandler {
    const router = {
      client: createUploadClient(),
      bucketName: getStorageConfig().bucketName,
      routes: mapValues(routes, toBetterUploadRoute),
    } satisfies Router;
    return (request) => handleRequest(request, router);
  }

  /**
   * Delete an object via a SigV4-signed `DELETE` issued through the same
   * configured S3 client used for presigning (`client.s3` is an aws4fetch
   * `AwsClient`), so no extra SDK/dependency is needed. S3 returns 204 for a
   * successful delete and 204/404 when the object is already gone — both are
   * treated as success (idempotent).
   */
  async deleteObject(
    objectKey: string
  ): Promise<ApplicationResult<ObjectDeleteOutcome>> {
    const config = getStorageConfig();
    const client = createUploadClient();
    const objectUrl = `${client.buildBucketUrl(config.bucketName)}/${objectKey}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      OBJECT_DELETE_TIMEOUT_MS
    );

    try {
      const response = await client.s3.fetch(objectUrl, {
        method: 'DELETE',
        signal: controller.signal,
      });
      if (response.ok || response.status === 404) {
        return Result.Ok({ type: 'object_deleted' });
      }
      return Result.Error(
        new AppError({
          code: 'OBJECT_STORAGE_DELETE_FAILED',
          category: 'system',
          status: 502,
          message: `Object storage delete failed with status ${response.status}`,
        })
      );
    } catch (error) {
      return Result.Error(
        new AppError({
          code: 'OBJECT_STORAGE_DELETE_FAILED',
          category: 'system',
          status: 502,
          message: 'Object storage delete failed',
          cause: error,
        })
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
