import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { and, asc, eq, exists, isNull, lte, or, sql } from 'drizzle-orm';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import {
  toDesignId,
  toItemId,
  toItemVersionId,
  toObjectKey,
} from '@/modules/kernel/domain/ids';
import { observeRepository } from '@/modules/kernel/infrastructure/db/observability';
import { design } from '@/modules/kernel/infrastructure/db/schema';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';
import type {
  ItemRepository,
  NewItemVersion,
} from '@/modules/moodboard/application/ports/item-repository';
import {
  type CutoutStatus,
  cutoutStatuses,
  type Item,
  type ItemKind,
  itemKinds,
  type ItemVersion,
  toItemCategory,
  toItemName,
} from '@/modules/moodboard/domain/item';

import {
  item as itemTable,
  type ItemRow,
  itemVersion as versionTable,
  type ItemVersionRow,
} from './schema';

const rowError = (cause: unknown) =>
  new AppError({
    code: 'ITEM_ROW_INVALID',
    category: 'system',
    status: 500,
    message: 'Item row contains invalid data',
    cause,
  });

const dbError = (cause: unknown) =>
  new AppError({
    code: 'ITEM_REPOSITORY_ERROR',
    category: 'system',
    status: 500,
    message: 'Item persistence failed',
    cause,
  });

const isKind = (value: string): value is ItemKind =>
  (itemKinds as readonly string[]).includes(value);
const isCutoutStatus = (value: string): value is CutoutStatus =>
  (cutoutStatuses as readonly string[]).includes(value);

const toVersion = (row: ItemVersionRow): BoxedResult<ItemVersion, AppError> => {
  const id = toItemVersionId(row.id);
  const itemId = toItemId(row.itemId);
  const photoKey = toObjectKey(row.photoKey);
  const cutoutKey = row.cutoutKey ? toObjectKey(row.cutoutKey) : undefined;
  const maskKey = row.maskKey ? toObjectKey(row.maskKey) : undefined;
  if (
    id.isError() ||
    itemId.isError() ||
    photoKey.isError() ||
    (cutoutKey !== undefined && cutoutKey.isError()) ||
    (maskKey !== undefined && maskKey.isError()) ||
    !isCutoutStatus(row.cutoutStatus)
  ) {
    return Result.Error(rowError(row.id));
  }
  return Result.Ok({
    id: id.get(),
    itemId: itemId.get(),
    number: row.number,
    photo: {
      key: photoKey.get(),
      contentType: row.photoContentType,
      width: row.photoWidth,
      height: row.photoHeight,
    },
    cutoutKey: cutoutKey?.isOk() ? cutoutKey.get() : null,
    maskKey: maskKey?.isOk() ? maskKey.get() : null,
    cutoutStatus: row.cutoutStatus,
    cutoutAttemptStartedAt: row.cutoutAttemptStartedAt,
    createdAt: row.createdAt,
  });
};

const toItem = (
  row: ItemRow,
  versionRow: ItemVersionRow
): BoxedResult<Item, AppError> => {
  const id = toItemId(row.id);
  const designId = toDesignId(row.designId);
  const name = toItemName(row.name);
  const category = toItemCategory(row.category);
  const version = toVersion(versionRow);
  if (
    id.isError() ||
    designId.isError() ||
    name.isError() ||
    category.isError() ||
    version.isError() ||
    !isKind(row.kind)
  ) {
    return Result.Error(rowError(row.id));
  }
  return Result.Ok({
    id: id.get(),
    designId: designId.get(),
    kind: row.kind,
    name: name.get(),
    category: category.get(),
    vendor: row.vendor,
    productUrl: row.productUrl,
    currentVersion: version.get(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
};

const versionValues = (itemId: string, number: number, v: NewItemVersion) => ({
  id: v.id,
  itemId,
  number,
  photoKey: v.photo.key,
  photoContentType: v.photo.contentType,
  photoWidth: v.photo.width,
  photoHeight: v.photo.height,
  cutoutKey: v.cutoutKey,
  maskKey: v.maskKey,
  cutoutStatus: v.cutoutStatus,
  cutoutAttemptId: v.cutoutAttempt?.id ?? null,
  cutoutAttemptStartedAt: v.cutoutAttempt?.startedAt ?? null,
});

export const createItemRepository = ({
  db,
}: {
  db: DbLike;
}): ItemRepository => {
  const selectItems = () =>
    db
      .select({ item: itemTable, version: versionTable })
      .from(itemTable)
      .innerJoin(versionTable, eq(versionTable.id, itemTable.currentVersionId));

  const findOne = async (
    where: ReturnType<typeof eq>
  ): Promise<
    BoxedResult<
      { type: 'item_found'; item: Item } | { type: 'item_not_found' },
      AppError
    >
  > => {
    const [row] = await selectItems()
      .where(and(where, isNull(itemTable.removedAt)))
      .limit(1);
    if (!row) return Result.Ok({ type: 'item_not_found' });
    const parsed = toItem(row.item, row.version);
    if (parsed.isError()) return Result.Error(parsed.getError());
    return Result.Ok({ type: 'item_found', item: parsed.get() });
  };

  const repository: ItemRepository = {
    async listByDesign(designId) {
      try {
        const rows = await selectItems()
          .where(
            and(eq(itemTable.designId, designId), isNull(itemTable.removedAt))
          )
          .orderBy(asc(itemTable.createdAt), asc(itemTable.id));
        const items: Item[] = [];
        for (const row of rows) {
          const parsed = toItem(row.item, row.version);
          if (parsed.isError()) return Result.Error(parsed.getError());
          items.push(parsed.get());
        }
        return Result.Ok({ type: 'items_listed', items });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async findInDesign(input) {
      try {
        const [row] = await selectItems()
          .where(
            and(
              eq(itemTable.id, input.itemId),
              eq(itemTable.designId, input.designId),
              isNull(itemTable.removedAt)
            )
          )
          .limit(1);
        if (!row) return Result.Ok({ type: 'item_not_found' });
        const parsed = toItem(row.item, row.version);
        if (parsed.isError()) return Result.Error(parsed.getError());
        return Result.Ok({ type: 'item_found', item: parsed.get() });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async findById(itemId) {
      try {
        return await findOne(eq(itemTable.id, itemId));
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async create(input) {
      try {
        await db.transaction(async (tx) => {
          await tx.insert(itemTable).values({
            id: input.id,
            designId: input.designId,
            kind: input.kind,
            name: input.name,
            category: input.category,
            vendor: input.vendor,
            productUrl: input.productUrl,
            currentVersionId: input.version.id,
          });
          await tx
            .insert(versionTable)
            .values(versionValues(input.id, 1, input.version));
        });
        const found = await findOne(eq(itemTable.id, input.id));
        if (found.isError()) return Result.Error(found.getError());
        const outcome = found.get();
        if (outcome.type !== 'item_found') {
          return Result.Error(dbError('created item not found'));
        }
        return Result.Ok({ type: 'item_created', item: outcome.item });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async update(input) {
      try {
        const changes = input.changes;
        const [updated] = await db
          .update(itemTable)
          .set({
            ...(changes.name !== undefined ? { name: changes.name } : {}),
            ...(changes.category !== undefined
              ? { category: changes.category }
              : {}),
            ...(changes.vendor !== undefined ? { vendor: changes.vendor } : {}),
            ...(changes.productUrl !== undefined
              ? { productUrl: changes.productUrl }
              : {}),
          })
          .where(
            and(eq(itemTable.id, input.itemId), isNull(itemTable.removedAt))
          )
          .returning({ id: itemTable.id });
        if (!updated) return Result.Ok({ type: 'item_not_found' });
        return await findOne(eq(itemTable.id, input.itemId));
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async addVersion(input) {
      try {
        const done = await db.transaction(async (tx) => {
          const [current] = await tx
            .select({
              max: sql<number>`coalesce(max(${versionTable.number}), 0)`,
            })
            .from(versionTable)
            .where(eq(versionTable.itemId, input.itemId));
          const [exists] = await tx
            .select({ id: itemTable.id })
            .from(itemTable)
            .where(
              and(eq(itemTable.id, input.itemId), isNull(itemTable.removedAt))
            );
          if (!exists) return false;
          await tx
            .insert(versionTable)
            .values(
              versionValues(
                input.itemId,
                Number(current?.max ?? 0) + 1,
                input.version
              )
            );
          await tx
            .update(itemTable)
            .set({ currentVersionId: input.version.id })
            .where(eq(itemTable.id, input.itemId));
          return true;
        });
        if (!done) return Result.Ok({ type: 'item_not_found' });
        return await findOne(eq(itemTable.id, input.itemId));
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async remove(input) {
      try {
        const [removed] = await db
          .update(itemTable)
          .set({ removedAt: input.removedAt })
          .where(
            and(eq(itemTable.id, input.itemId), isNull(itemTable.removedAt))
          )
          .returning({ id: itemTable.id });
        return Result.Ok(
          removed ? { type: 'item_removed' } : { type: 'item_not_found' }
        );
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async findVersion(versionId) {
      try {
        const [row] = await db
          .select({ version: versionTable, designId: itemTable.designId })
          .from(versionTable)
          .innerJoin(itemTable, eq(itemTable.id, versionTable.itemId))
          .where(eq(versionTable.id, versionId))
          .limit(1);
        if (!row) return Result.Ok({ type: 'item_version_not_found' });
        const version = toVersion(row.version);
        const designId = toDesignId(row.designId);
        if (version.isError() || designId.isError()) {
          return Result.Error(rowError(versionId));
        }
        return Result.Ok({
          type: 'item_version_found',
          version: version.get(),
          cutoutAttemptId: row.version.cutoutAttemptId,
          designId: designId.get(),
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async claimCutoutAttempt(input) {
      const expiredBefore = new Date(input.expiredBeforeMs);
      try {
        const [claimed] = await db
          .update(versionTable)
          .set({
            cutoutStatus: 'pending',
            cutoutKey: null,
            cutoutAttemptId: input.attemptId,
            cutoutAttemptStartedAt: input.startedAt,
          })
          .where(
            and(
              eq(versionTable.id, input.versionId),
              or(
                eq(versionTable.cutoutStatus, 'failed'),
                and(
                  eq(versionTable.cutoutStatus, 'pending'),
                  or(
                    lte(versionTable.cutoutAttemptStartedAt, expiredBefore),
                    and(
                      isNull(versionTable.cutoutAttemptStartedAt),
                      lte(versionTable.createdAt, expiredBefore)
                    )
                  )
                )
              ),
              exists(
                db
                  .select({ id: itemTable.id })
                  .from(itemTable)
                  .where(
                    and(
                      eq(itemTable.id, versionTable.itemId),
                      eq(itemTable.currentVersionId, versionTable.id),
                      isNull(itemTable.removedAt)
                    )
                  )
              )
            )
          )
          .returning({ id: versionTable.id });
        return Result.Ok({
          type: claimed ? 'cutout_attempt_claimed' : 'cutout_attempt_skipped',
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async finishCutoutAttempt(input) {
      try {
        const [saved] = await db
          .update(versionTable)
          .set({ cutoutStatus: input.cutoutStatus, cutoutKey: input.cutoutKey })
          .where(
            and(
              eq(versionTable.id, input.versionId),
              eq(versionTable.cutoutStatus, 'pending'),
              input.attemptId === null
                ? isNull(versionTable.cutoutAttemptId)
                : eq(versionTable.cutoutAttemptId, input.attemptId)
            )
          )
          .returning({ id: versionTable.id });
        return Result.Ok({
          type: saved ? 'cutout_result_saved' : 'cutout_attempt_skipped',
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async checkAbandonedCutout(input) {
      try {
        const [inUse] = await db
          .select({ id: versionTable.id })
          .from(versionTable)
          .where(
            or(
              eq(versionTable.cutoutKey, input.cutoutKey),
              eq(versionTable.photoKey, input.cutoutKey),
              eq(versionTable.maskKey, input.cutoutKey),
              and(
                eq(versionTable.id, input.versionId),
                eq(versionTable.cutoutStatus, 'pending'),
                input.attemptId === null
                  ? isNull(versionTable.cutoutAttemptId)
                  : eq(versionTable.cutoutAttemptId, input.attemptId)
              )
            )
          )
          .limit(1);
        return Result.Ok({
          type: inUse ? 'cutout_object_in_use' : 'cutout_object_abandoned',
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async categoryUsage(ownerId) {
      try {
        const rows = await db
          .select({
            category: itemTable.category,
            count: sql<number>`cast(count(*) as integer)`,
          })
          .from(itemTable)
          .innerJoin(design, eq(design.id, itemTable.designId))
          .where(and(eq(design.ownerId, ownerId), isNull(itemTable.removedAt)))
          .groupBy(itemTable.category);
        return Result.Ok({ type: 'category_usage', usage: rows });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
  };

  return observeRepository(repository, 'item');
};
