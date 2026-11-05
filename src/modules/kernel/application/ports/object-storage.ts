/**
 * Provider-neutral object-storage upload port.
 *
 * Abstracts the presigned-upload mechanism so transport and composition do not
 * depend on a specific upload SDK. The current adapter is better-upload + S3
 * (`infrastructure/storage`), but any provider can implement this port. A route
 * `prepare` hook rejects an upload by returning `Result.Error(UploadRejectedError)`
 * (`domain/errors/upload-rejected-error`); the adapter maps that to its
 * provider's rejection mechanism. Only genuine system failures propagate.
 */

import type { Result } from '@bloodyowl/boxed';

import type { ApplicationResult } from '../result';
import type { UploadRejectedError } from '../../domain/errors/upload-rejected-error';

export type ObjectUploadPrepared = {
  /** Server-generated storage object key. The client never controls this. */
  objectKey: string;
  /** Optional `Cache-Control` pinned on the stored object. */
  cacheControl?: string;
};

export type ObjectUploadRouteDefinition = {
  fileTypes: string[];
  maxFileSize: number;
  /**
   * Resolve the server-decided object key (+ optional cache-control) for an
   * incoming upload, or reject it with `Result.Error(UploadRejectedError)`.
   * Genuine system failures reject the promise and propagate.
   */
  prepare: (ctx: {
    headers: Headers;
    fileType: string;
  }) => Promise<Result<ObjectUploadPrepared, UploadRejectedError>>;
};

export type ObjectUploadRequestHandler = (
  request: Request
) => Promise<Response>;

/**
 * Outcome of deleting a stored object. Deleting a key that does not exist is a
 * success (idempotent) so callers can reclaim covers without racing.
 */
export type ObjectDeleteOutcome = { type: 'object_deleted' };

export type ObjectStoredOutcome = { type: 'object_stored'; objectKey: string };

export type ObjectBytesOutcome =
  | {
      type: 'object_found';
      bytes: Uint8Array;
      contentType: string | undefined;
    }
  | { type: 'object_not_found' };

export type SignedReadUrlOutcome = { type: 'signed_read_url'; url: string };

export type ObjectCopyOutcome =
  | {
      type: 'object_copied';
      objectKey: string;
      contentType: string;
      byteLength: number;
    }
  /** The source answered with a non-success status (e.g. expired link). */
  | { type: 'copy_source_unavailable'; status: number }
  | {
      type: 'copy_source_unavailable';
      reason: 'timeout' | 'network';
      status?: never;
    }
  /** The source answered, but its type or size breaks the given limits. */
  | {
      type: 'copy_source_rejected';
      reason:
        | 'content_type'
        | 'declared_too_large'
        | 'too_large'
        | 'insecure_url';
    };

export type ObjectWriteInput = {
  objectKey: string;
  body: Uint8Array;
  contentType: string;
  cacheControl?: string;
};
export type ObjectCopyInput = {
  sourceUrl: string;
  objectKey: string;
  acceptedContentTypes: readonly string[];
  maxBytes: number;
  cacheControl?: string;
};
export type ObjectCreateOutcome =
  | { type: 'object_created'; objectKey: string }
  | { type: 'object_already_exists' };
export type ObjectCopyNewOutcome =
  | Exclude<ObjectCopyOutcome, { type: 'object_copied' }>
  | ObjectCreateOutcome;

export type ObjectStoragePort = {
  /**
   * Build an HTTP handler that serves presigned uploads for the given named
   * routes.
   */
  createUploadRequestHandler: (
    routes: Record<string, ObjectUploadRouteDefinition>
  ) => ObjectUploadRequestHandler;
  /**
   * Delete a stored object by its server-generated key. Idempotent: a missing
   * object resolves `object_deleted`. Genuine provider/transport failures are
   * returned as `Result.Error(AppError)`.
   */
  deleteObject: (
    objectKey: string
  ) => Promise<ApplicationResult<ObjectDeleteOutcome>>;
  /** Atomic create-only writes. Success proves this call created the key.
   * Conflicts never change the object. Errors give no ownership proof.
   */
  createObject: (
    input: ObjectWriteInput
  ) => Promise<ApplicationResult<ObjectCreateOutcome>>;
  /** Source failures are tagged and guarantee no destination write was attempted. */
  copyNewObjectFromUrl: (
    input: ObjectCopyInput
  ) => Promise<ApplicationResult<ObjectCopyNewOutcome>>;
  /** Server-side write (e.g. a mask rewritten for a provider's polarity). */
  putObject: (input: {
    objectKey: string;
    body: Uint8Array;
    contentType: string;
    cacheControl?: string;
  }) => Promise<ApplicationResult<ObjectStoredOutcome>>;
  /** Server-side read of a stored object's bytes. */
  getObjectBytes: (
    objectKey: string
  ) => Promise<ApplicationResult<ObjectBytesOutcome>>;
  /**
   * Short-lived signed `GET` URL for the private bucket. Used by the browser
   * and by model providers fetching request inputs. `attachmentFileName`
   * forces a download with that filename.
   */
  createSignedReadUrl: (input: {
    objectKey: string;
    expiresInSeconds: number;
    attachmentFileName?: string;
  }) => Promise<ApplicationResult<SignedReadUrlOutcome>>;
  /**
   * Copy a provider-hosted result (HTTPS URL) into owned storage. Rejects
   * non-HTTPS sources, unexpected content types and oversized bodies.
   */
  copyFromUrl: (input: {
    sourceUrl: string;
    objectKey: string;
    acceptedContentTypes: readonly string[];
    maxBytes: number;
    cacheControl?: string;
  }) => Promise<ApplicationResult<ObjectCopyOutcome>>;
};
