import { Result } from '@bloodyowl/boxed';
import { and, eq, gt, isNull } from 'drizzle-orm';

import type { UploadIntentStore } from '@/modules/kernel/application/ports/upload-intent-store';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { observeRepository } from '@/modules/kernel/infrastructure/db/observability';
import { uploadIntent } from '@/modules/kernel/infrastructure/db/schema/upload-intent';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';

const uploadIntentError = (code: string, cause: unknown) =>
  new AppError({
    code,
    category: 'system',
    status: 500,
    message: 'Upload intent persistence failed',
    cause,
  });

export const createUploadIntentStore = ({
  db,
}: {
  db: DbLike;
}): UploadIntentStore =>
  observeRepository<UploadIntentStore>(
    {
      async remember(input) {
        try {
          await db
            .insert(uploadIntent)
            .values({
              objectKey: input.objectKey,
              userId: input.userId,
              purpose: input.purpose,
              contentType: input.contentType,
              expiresAt: input.expiresAt,
            })
            .onConflictDoNothing();
          return Result.Ok({ type: 'upload_intent_remembered' as const });
        } catch (error) {
          return Result.Error(
            uploadIntentError('UPLOAD_INTENT_REMEMBER_FAILED', error)
          );
        }
      },
      async consume(input) {
        try {
          const rows = await db
            .update(uploadIntent)
            .set({ consumedAt: input.now })
            .where(
              and(
                eq(uploadIntent.objectKey, input.objectKey),
                eq(uploadIntent.userId, input.userId),
                eq(uploadIntent.purpose, input.purpose),
                isNull(uploadIntent.consumedAt),
                gt(uploadIntent.expiresAt, input.now)
              )
            )
            .returning({ contentType: uploadIntent.contentType });
          const row = rows[0];
          return row
            ? Result.Ok({
                type: 'upload_intent_consumed' as const,
                contentType: row.contentType,
              })
            : Result.Ok({ type: 'upload_intent_unowned' as const });
        } catch (error) {
          return Result.Error(
            uploadIntentError('UPLOAD_INTENT_CONSUME_FAILED', error)
          );
        }
      },
    },
    'upload_intent'
  );
