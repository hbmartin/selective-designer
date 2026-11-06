import { Result } from '@bloodyowl/boxed';

import type { ProviderAccounting, ProviderCallReceipt } from '@/modules/kernel';
import type {
  ObjectStoragePort,
  ProviderCallLog,
  ProviderCallRecord,
  UploadIntentStore,
} from '@/modules/kernel';
import { AppError } from '@/modules/kernel';

type StoredObject = { bytes: Uint8Array; contentType: string };

/** In-memory {@link ObjectStoragePort} for unit tests. */
export const createFakeObjectStorage = () => {
  const objects = new Map<string, StoredObject>();
  const remoteSources = new Map<string, StoredObject>();
  const storage: ObjectStoragePort = {
    createUploadRequestHandler: () => async () =>
      new Response(null, { status: 501 }),
    async deleteObject(objectKey) {
      objects.delete(objectKey);
      return Result.Ok({ type: 'object_deleted' });
    },
    async putObject(input) {
      objects.set(input.objectKey, {
        bytes: input.body,
        contentType: input.contentType,
      });
      return Result.Ok({ type: 'object_stored', objectKey: input.objectKey });
    },
    async createObject(input) {
      if (objects.has(input.objectKey))
        return Result.Ok({ type: 'object_already_exists' });
      const written = await storage.putObject(input);
      return written.map(() => ({
        type: 'object_created' as const,
        objectKey: input.objectKey,
      }));
    },
    async copyNewObjectFromUrl(input) {
      try {
        if (new URL(input.sourceUrl).protocol !== 'https:')
          return Result.Ok({
            type: 'copy_source_rejected',
            reason: 'insecure_url',
          });
      } catch {
        return Result.Ok({
          type: 'copy_source_rejected',
          reason: 'insecure_url',
        });
      }
      const source = remoteSources.get(input.sourceUrl);
      if (!source)
        return Result.Ok({ type: 'copy_source_unavailable', status: 404 });
      if (!input.acceptedContentTypes.includes(source.contentType))
        return Result.Ok({
          type: 'copy_source_rejected',
          reason: 'content_type',
        });
      if (source.bytes.byteLength > input.maxBytes)
        return Result.Ok({ type: 'copy_source_rejected', reason: 'too_large' });
      return storage.createObject({
        ...input,
        body: source.bytes,
        contentType: source.contentType,
      });
    },
    async getObjectMetadata(objectKey) {
      const object = objects.get(objectKey);
      return Result.Ok(
        object
          ? {
              type: 'object_found',
              contentType: object.contentType,
              byteLength: object.bytes.byteLength,
            }
          : { type: 'object_not_found' }
      );
    },
    async getObjectBytes(objectKey) {
      const object = objects.get(objectKey);
      return Result.Ok(
        object
          ? {
              type: 'object_found',
              bytes: object.bytes,
              contentType: object.contentType,
            }
          : { type: 'object_not_found' }
      );
    },
    async createSignedReadUrl(input) {
      const suffix = input.attachmentFileName
        ? `&download=${encodeURIComponent(input.attachmentFileName)}`
        : '';
      return Result.Ok({
        type: 'signed_read_url',
        url: `https://storage.test/${input.objectKey}?expires=${input.expiresInSeconds}${suffix}`,
      });
    },
    async copyFromUrl(input) {
      try {
        if (new URL(input.sourceUrl).protocol !== 'https:')
          return Result.Ok({
            type: 'copy_source_rejected',
            reason: 'insecure_url',
          });
      } catch {
        return Result.Ok({
          type: 'copy_source_rejected',
          reason: 'insecure_url',
        });
      }
      const source = remoteSources.get(input.sourceUrl);
      if (!source)
        return Result.Ok({ type: 'copy_source_unavailable', status: 404 });
      if (!input.acceptedContentTypes.includes(source.contentType)) {
        return Result.Ok({
          type: 'copy_source_rejected',
          reason: 'content_type',
        });
      }
      if (source.bytes.byteLength > input.maxBytes) {
        return Result.Ok({ type: 'copy_source_rejected', reason: 'too_large' });
      }
      objects.set(input.objectKey, source);
      return Result.Ok({
        type: 'object_copied',
        objectKey: input.objectKey,
        contentType: source.contentType,
        byteLength: source.bytes.byteLength,
      });
    },
  };
  return {
    storage,
    objects,
    /** Register a provider-hosted URL that `copyFromUrl` can fetch. */
    addRemoteSource: (url: string, object: StoredObject) =>
      remoteSources.set(url, object),
  };
};

/** In-memory {@link UploadIntentStore} for unit tests. */
export const createFakeUploadIntentStore = () => {
  const intents = new Map<
    string,
    {
      userId: string;
      purpose: string;
      contentType: string;
      expiresAt: Date;
      consumed: boolean;
    }
  >();
  const store: UploadIntentStore = {
    async remember(input) {
      if (!intents.has(input.objectKey)) {
        intents.set(input.objectKey, {
          userId: input.userId,
          purpose: input.purpose,
          contentType: input.contentType,
          expiresAt: input.expiresAt,
          consumed: false,
        });
      }
      return Result.Ok({ type: 'upload_intent_remembered' });
    },
    async consume(input) {
      const intent = intents.get(input.objectKey);
      if (
        !intent ||
        intent.consumed ||
        intent.userId !== input.userId ||
        intent.purpose !== input.purpose ||
        intent.expiresAt.getTime() <= input.now.getTime()
      ) {
        return Result.Ok({ type: 'upload_intent_unowned' });
      }
      intent.consumed = true;
      return Result.Ok({
        type: 'upload_intent_consumed',
        contentType: intent.contentType,
      });
    },
  };
  return { store, intents };
};

/** In-memory {@link ProviderCallLog} for unit tests. */
export const createFakeProviderCallLog = () => {
  const calls = new Map<string, ProviderCallRecord>();
  const log: ProviderCallLog = {
    async record(call) {
      if (calls.get(call.id)?.status !== 'succeeded') calls.set(call.id, call);
      return Result.Ok({ type: 'provider_call_recorded' });
    },
  };
  const receipts = new Map<string, ProviderCallReceipt>();
  const delivered = new Set<string>();
  const accounting: ProviderAccounting = {
    async capture(receipt) {
      const existing = receipts.get(receipt.id);
      if (
        existing &&
        (existing.provider !== receipt.provider ||
          existing.endpoint !== receipt.endpoint ||
          existing.providerRequestId !== receipt.providerRequestId ||
          existing.purpose !== receipt.purpose ||
          existing.subjectId !== receipt.subjectId ||
          existing.designId !== receipt.designId ||
          existing.userId !== receipt.userId ||
          existing.startedAt !== receipt.startedAt)
      )
        return Result.Error(
          new AppError({
            code: 'PROVIDER_RECEIPT_IDENTITY_MISMATCH',
            category: 'system',
            status: 500,
          })
        );
      if (
        !existing ||
        (existing.status !== 'succeeded' &&
          (receipt.status === 'succeeded' ||
            (existing.status === 'submitted' && receipt.status === 'failed')))
      ) {
        receipts.set(receipt.id, {
          ...receipt,
          costUsdMicros: receipt.costUsdMicros ?? existing?.costUsdMicros,
        });
        delivered.delete(receipt.id);
      }
      return Result.Ok({ type: 'receipt_captured', receiptId: receipt.id });
    },
    async deliver(id) {
      const receipt = receipts.get(id);
      if (!receipt) return Result.Ok({ type: 'receipt_missing' });
      const result = await log.record({
        ...receipt,
        startedAt: new Date(receipt.startedAt),
        completedAt:
          receipt.completedAt === undefined
            ? undefined
            : new Date(receipt.completedAt),
      });
      if (result.isError()) return Result.Error(result.getError());
      delivered.add(id);
      return Result.Ok({ type: 'receipt_delivered' });
    },
  };
  return { log, calls, accounting, receipts, delivered };
};
