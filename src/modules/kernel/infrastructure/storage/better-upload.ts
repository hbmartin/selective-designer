import {
  handleRequest,
  RejectUpload,
  route,
  type Router,
} from '@better-upload/server';
import { custom } from '@better-upload/server/clients';
import { getObjectBlob, putObject } from '@better-upload/server/helpers';
import { Result } from '@bloodyowl/boxed';
import { mapValues } from 'remeda';

import type {
  ObjectBytesOutcome,
  ObjectCopyOutcome,
  ObjectDeleteOutcome,
  ObjectStoragePort,
  ObjectStoredOutcome,
  ObjectUploadRequestHandler,
  ObjectUploadRouteDefinition,
  SignedReadUrlOutcome,
} from '@/modules/kernel/application/ports/object-storage';
import type { ApplicationResult } from '@/modules/kernel/application/result';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { getStorageConfig } from '@/modules/kernel/infrastructure/config/storage';

import { readLimitedBody } from './limited-response-body';

const OBJECT_DELETE_TIMEOUT_MS = 5_000;
const OBJECT_COPY_TIMEOUT_MS = 60_000;
const MAX_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;

const storageError = (code: string, message: string, cause?: unknown) =>
  new AppError({ code, category: 'system', status: 502, message, cause });

const isNotFoundError = (error: unknown) =>
  error instanceof Error && /\b404\b|NoSuchKey|not found/iu.test(error.message);

/** RFC 6266 filename: ASCII only, no quotes or path separators. */
const safeAttachmentFileName = (fileName: string) =>
  fileName.replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 120) || 'download';

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
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = getStorageConfig();
      const client = createUploadClient();
      const objectUrl = `${client.buildBucketUrl(config.bucketName)}/${objectKey}`;
      const controller = new AbortController();
      timeoutId = setTimeout(
        () => controller.abort(),
        OBJECT_DELETE_TIMEOUT_MS
      );
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

  async putObject(input: {
    objectKey: string;
    body: Uint8Array;
    contentType: string;
    cacheControl?: string;
  }): Promise<ApplicationResult<ObjectStoredOutcome>> {
    try {
      await putObject(createUploadClient(), {
        bucket: getStorageConfig().bucketName,
        key: input.objectKey,
        // Copy into a fresh ArrayBuffer-backed view so it satisfies BodyInit.
        body: new Uint8Array(input.body),
        contentType: input.contentType,
        contentLength: input.body.byteLength,
        ...(input.cacheControl ? { cacheControl: input.cacheControl } : {}),
      });
      return Result.Ok({ type: 'object_stored', objectKey: input.objectKey });
    } catch (error) {
      return Result.Error(
        storageError(
          'OBJECT_STORAGE_PUT_FAILED',
          'Object storage put failed',
          error
        )
      );
    }
  }

  async getObjectBytes(
    objectKey: string
  ): Promise<ApplicationResult<ObjectBytesOutcome>> {
    try {
      const object = await getObjectBlob(createUploadClient(), {
        bucket: getStorageConfig().bucketName,
        key: objectKey,
      });
      return Result.Ok({
        type: 'object_found',
        bytes: new Uint8Array(await object.blob.arrayBuffer()),
        contentType: object.contentType ?? undefined,
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        return Result.Ok({ type: 'object_not_found' });
      }
      return Result.Error(
        storageError(
          'OBJECT_STORAGE_GET_FAILED',
          'Object storage get failed',
          error
        )
      );
    }
  }

  /**
   * Presign a `GET` with aws4fetch query signing. better-upload's
   * `presignGetObject` cannot set `response-content-disposition`, so the URL
   * is built here with the same client.
   */
  async createSignedReadUrl(input: {
    objectKey: string;
    expiresInSeconds: number;
    attachmentFileName?: string;
  }): Promise<ApplicationResult<SignedReadUrlOutcome>> {
    try {
      const config = getStorageConfig();
      const client = createUploadClient();
      const url = new URL(
        `${client.buildBucketUrl(config.bucketName)}/${input.objectKey}`
      );
      url.searchParams.set(
        'X-Amz-Expires',
        String(
          Math.min(Math.max(1, input.expiresInSeconds), MAX_SIGNED_URL_SECONDS)
        )
      );
      if (input.attachmentFileName) {
        url.searchParams.set(
          'response-content-disposition',
          `attachment; filename="${safeAttachmentFileName(input.attachmentFileName)}"`
        );
      }
      const signed = await client.s3.sign(url.toString(), {
        method: 'GET',
        aws: { signQuery: true, allHeaders: true },
      });
      return Result.Ok({ type: 'signed_read_url', url: signed.url });
    } catch (error) {
      return Result.Error(
        storageError(
          'OBJECT_STORAGE_SIGN_FAILED',
          'Object storage URL signing failed',
          error
        )
      );
    }
  }

  async copyFromUrl(input: {
    sourceUrl: string;
    objectKey: string;
    acceptedContentTypes: readonly string[];
    maxBytes: number;
    cacheControl?: string;
  }): Promise<ApplicationResult<ObjectCopyOutcome>> {
    let source: URL;
    try {
      source = new URL(input.sourceUrl);
    } catch {
      return Result.Ok({
        type: 'copy_source_rejected',
        reason: 'insecure_url',
      });
    }
    if (source.protocol !== 'https:') {
      return Result.Ok({
        type: 'copy_source_rejected',
        reason: 'insecure_url',
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      OBJECT_COPY_TIMEOUT_MS
    );
    try {
      const response = await fetch(source, {
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) {
        return Result.Ok({
          type: 'copy_source_unavailable',
          status: response.status,
        });
      }
      const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase();
      if (
        !contentType ||
        !input.acceptedContentTypes
          .map((type) => type.toLowerCase())
          .includes(contentType)
      ) {
        return Result.Ok({
          type: 'copy_source_rejected',
          reason: 'content_type',
        });
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) {
        return Result.Ok({ type: 'copy_source_rejected', reason: 'too_large' });
      }
      const bytes = await readLimitedBody(response, input.maxBytes);
      if (!bytes) {
        return Result.Ok({ type: 'copy_source_rejected', reason: 'too_large' });
      }
      const stored = await this.putObject({
        objectKey: input.objectKey,
        body: bytes,
        contentType,
        ...(input.cacheControl ? { cacheControl: input.cacheControl } : {}),
      });
      if (stored.isError()) return Result.Error(stored.getError());
      return Result.Ok({
        type: 'object_copied',
        objectKey: input.objectKey,
        contentType,
        byteLength: bytes.byteLength,
      });
    } catch (error) {
      return Result.Error(
        storageError(
          'OBJECT_STORAGE_COPY_FAILED',
          'Copying a provider result into storage failed',
          error
        )
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
