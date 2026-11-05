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
  ObjectCopyInput,
  ObjectCopyNewOutcome,
  ObjectCopyOutcome,
  ObjectCreateOutcome,
  ObjectDeleteOutcome,
  ObjectStoragePort,
  ObjectStoredOutcome,
  ObjectUploadRequestHandler,
  ObjectUploadRouteDefinition,
  ObjectWriteInput,
  SignedReadUrlOutcome,
} from '@/modules/kernel/application/ports/object-storage';
import type { ApplicationResult } from '@/modules/kernel/application/result';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { ObjectCopySourceError } from '@/modules/kernel/domain/errors/object-copy-source-error';
import { getStorageConfig } from '@/modules/kernel/infrastructure/config/storage';

import {
  discardResponseBody,
  hasOversizedResponseBody,
  readLimitedBody,
} from './limited-response-body';

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
      await discardResponseBody(response);
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

  async createObject(
    input: ObjectWriteInput
  ): Promise<ApplicationResult<ObjectCreateOutcome>> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = getStorageConfig();
      const client = createUploadClient();
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), OBJECT_COPY_TIMEOUT_MS);
      const response = await client.s3.fetch(
        `${client.buildBucketUrl(config.bucketName)}/${input.objectKey}`,
        {
          method: 'PUT',
          signal: controller.signal,
          headers: {
            'If-None-Match': '*',
            'Content-Type': input.contentType,
            'Content-Length': String(input.body.byteLength),
            ...(input.cacheControl
              ? { 'Cache-Control': input.cacheControl }
              : {}),
          },
          body: new Uint8Array(input.body),
        }
      );
      await discardResponseBody(response);
      if (response.status === 412)
        return Result.Ok({ type: 'object_already_exists' });
      if (response.ok)
        return Result.Ok({
          type: 'object_created',
          objectKey: input.objectKey,
        });
      return Result.Error(
        storageError(
          'OBJECT_STORAGE_CREATE_FAILED',
          `Object storage create failed with status ${response.status}`
        )
      );
    } catch (cause) {
      return Result.Error(
        storageError(
          'OBJECT_STORAGE_CREATE_FAILED',
          'Object storage create failed',
          cause
        )
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async copyNewObjectFromUrl(
    input: ObjectCopyInput
  ): Promise<ApplicationResult<ObjectCopyNewOutcome>> {
    const downloaded = await this.readCopySource(input);
    if (downloaded.isError()) return Result.Error(downloaded.getError());
    const source = downloaded.get();
    if (source.type !== 'copy_source_downloaded') return Result.Ok(source);
    return this.createObject({
      objectKey: input.objectKey,
      body: source.bytes,
      contentType: source.contentType,
      ...(input.cacheControl ? { cacheControl: input.cacheControl } : {}),
    });
  }

  async copyFromUrl(
    input: ObjectCopyInput
  ): Promise<ApplicationResult<ObjectCopyOutcome>> {
    const downloaded = await this.readCopySource(input);
    if (downloaded.isError()) return Result.Error(downloaded.getError());
    const source = downloaded.get();
    if (source.type !== 'copy_source_downloaded') return Result.Ok(source);
    const stored = await this.putObject({
      objectKey: input.objectKey,
      body: source.bytes,
      contentType: source.contentType,
      ...(input.cacheControl ? { cacheControl: input.cacheControl } : {}),
    });
    if (stored.isError()) return Result.Error(stored.getError());
    return Result.Ok({
      type: 'object_copied',
      objectKey: input.objectKey,
      contentType: source.contentType,
      byteLength: source.bytes.byteLength,
    });
  }

  private async readCopySource(input: ObjectCopyInput): Promise<
    ApplicationResult<
      | Exclude<ObjectCopyOutcome, { type: 'object_copied' }>
      | {
          type: 'copy_source_downloaded';
          bytes: Uint8Array;
          contentType: string;
        }
    >
  > {
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

    const deadline = performance.now() + OBJECT_COPY_TIMEOUT_MS;
    let lastError: ObjectCopySourceError | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const remaining = deadline - performance.now();
        const backoff = attempt === 1 ? 1_000 : 3_000;
        if (remaining <= backoff) break;
        // oxlint-disable-next-line no-await-in-loop -- bounded source-only backoff.
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        Math.min(20_000, remaining)
      );
      let response: Response | undefined;
      try {
        // oxlint-disable-next-line no-await-in-loop -- retry the same URL, never the paid provider call.
        response = await fetch(source, {
          redirect: 'follow',
          signal: controller.signal,
        });
        if (!response.ok) {
          // oxlint-disable-next-line no-await-in-loop -- release every rejected body.
          await discardResponseBody(response);
          if (
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500
          ) {
            lastError = new ObjectCopySourceError({
              reason: 'http',
              attempts: attempt + 1,
              status: response.status,
              cause: storageError(
                'OBJECT_COPY_SOURCE_HTTP',
                `Source HTTP ${response.status}`
              ),
            });
            continue;
          }
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
          // oxlint-disable-next-line no-await-in-loop -- discard unused source.
          await discardResponseBody(response);
          return Result.Ok({
            type: 'copy_source_rejected',
            reason: 'content_type',
          });
        }
        if (hasOversizedResponseBody(response, input.maxBytes)) {
          // oxlint-disable-next-line no-await-in-loop -- discard unused source.
          await discardResponseBody(response);
          return Result.Ok({
            type: 'copy_source_rejected',
            reason: 'declared_too_large',
          });
        }
        // oxlint-disable-next-line no-await-in-loop -- bounded source reads.
        const bytes = await readLimitedBody(response, input.maxBytes);
        if (!bytes)
          return Result.Ok({
            type: 'copy_source_rejected',
            reason: 'too_large',
          });
        return Result.Ok({
          type: 'copy_source_downloaded',
          bytes,
          contentType,
        });
      } catch (cause) {
        if (response) {
          // oxlint-disable-next-line no-await-in-loop -- a failed stream must release its body.
          await discardResponseBody(response);
        }
        lastError = new ObjectCopySourceError({
          reason:
            controller.signal.aborted ||
            (cause instanceof Error && cause.name === 'AbortError')
              ? 'timeout'
              : 'network',
          attempts: attempt + 1,
          cause,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return Result.Error(
      lastError ??
        new ObjectCopySourceError({
          reason: 'timeout',
          attempts: 0,
          cause: storageError(
            'OBJECT_COPY_SOURCE_TIMEOUT',
            'Source download budget exhausted'
          ),
        })
    );
  }
}
