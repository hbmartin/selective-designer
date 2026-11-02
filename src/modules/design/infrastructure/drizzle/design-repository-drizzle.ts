import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type {
  DesignRepository,
  NewDesignImage,
} from '@/modules/design/application/ports/design-repository';
import {
  type Design,
  type DesignImage,
  type DesignImageKind,
  designImageKinds,
  toDesignName,
} from '@/modules/design/domain/design';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import {
  toDesignId,
  toImageId,
  toObjectKey,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { observeRepository } from '@/modules/kernel/infrastructure/db/observability';
import {
  descendingDateCursorFilter,
  escapedIlikeFilter,
  takeCursorPage,
} from '@/modules/kernel/infrastructure/db/query-helpers';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';

import {
  design as designTable,
  type DesignRow,
  image as imageTable,
  type ImageRow,
} from './schema';

const rowError = (cause: unknown) =>
  new AppError({
    code: 'DESIGN_ROW_INVALID',
    category: 'system',
    status: 500,
    message: 'Design row contains invalid data',
    cause,
  });

const dbError = (cause: unknown) =>
  new AppError({
    code: 'DESIGN_REPOSITORY_ERROR',
    category: 'system',
    status: 500,
    message: 'Design persistence failed',
    cause,
  });

const isImageKind = (value: string): value is DesignImageKind =>
  (designImageKinds as readonly string[]).includes(value);

const toDomainImage = (row: ImageRow): BoxedResult<DesignImage, AppError> => {
  const id = toImageId(row.id);
  const designId = toDesignId(row.designId);
  const originalKey = toObjectKey(row.originalKey);
  const workingKey = toObjectKey(row.workingKey);
  if (
    id.isError() ||
    designId.isError() ||
    originalKey.isError() ||
    workingKey.isError() ||
    !isImageKind(row.kind)
  ) {
    return Result.Error(rowError(row.id));
  }
  return Result.Ok({
    id: id.get(),
    designId: designId.get(),
    kind: row.kind,
    originalKey: originalKey.get(),
    originalContentType: row.originalContentType,
    original: { width: row.originalWidth, height: row.originalHeight },
    workingKey: workingKey.get(),
    working: { width: row.workingWidth, height: row.workingHeight },
    createdAt: row.createdAt,
  });
};

const toDomainDesign = (
  row: DesignRow,
  baseImageRow: ImageRow
): BoxedResult<Design, AppError> => {
  const id = toDesignId(row.id);
  const ownerId = toUserId(row.ownerId);
  const name = toDesignName(row.name);
  const baseImage = toDomainImage(baseImageRow);
  const copiedFrom = row.copiedFromDesignId
    ? toDesignId(row.copiedFromDesignId)
    : undefined;
  if (
    id.isError() ||
    ownerId.isError() ||
    name.isError() ||
    baseImage.isError() ||
    (copiedFrom !== undefined && copiedFrom.isError())
  ) {
    return Result.Error(rowError(row.id));
  }
  return Result.Ok({
    id: id.get(),
    ownerId: ownerId.get(),
    name: name.get(),
    baseImage: baseImage.get(),
    copiedFromDesignId:
      copiedFrom !== undefined && copiedFrom.isOk() ? copiedFrom.get() : null,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
};

const toImageValues = (designId: string, image: NewDesignImage) => ({
  id: image.id,
  designId,
  kind: image.kind,
  originalKey: image.originalKey,
  originalContentType: image.originalContentType,
  originalWidth: image.original.width,
  originalHeight: image.original.height,
  workingKey: image.workingKey,
  workingWidth: image.working.width,
  workingHeight: image.working.height,
});

const designWithBaseImage = (db: DbLike) =>
  db
    .select({ design: designTable, baseImage: imageTable })
    .from(designTable)
    .innerJoin(imageTable, eq(imageTable.id, designTable.baseImageId));

export const createDesignRepository = ({
  db,
}: {
  db: DbLike;
}): DesignRepository => {
  const findOwnedRow = async (id: string, ownerId: string) => {
    const [row] = await designWithBaseImage(db)
      .where(and(eq(designTable.id, id), eq(designTable.ownerId, ownerId)))
      .limit(1);
    return row;
  };

  const repository: DesignRepository = {
    async list(query) {
      try {
        const ownerFilter = and(
          eq(designTable.ownerId, query.ownerId),
          query.archived
            ? isNotNull(designTable.archivedAt)
            : isNull(designTable.archivedAt),
          escapedIlikeFilter([designTable.name], query.searchTerm)
        );
        const cursorRow = query.cursor
          ? (
              await db
                .select({
                  id: designTable.id,
                  updatedAt: designTable.updatedAt,
                })
                .from(designTable)
                .where(eq(designTable.id, query.cursor))
                .limit(1)
            )[0]
          : undefined;

        const [totals, rows] = await Promise.all([
          db
            .select({ count: sql<number>`cast(count(*) as integer)` })
            .from(designTable)
            .where(ownerFilter),
          query.cursor && !cursorRow
            ? Promise.resolve([])
            : designWithBaseImage(db)
                .where(
                  and(
                    ownerFilter,
                    descendingDateCursorFilter({
                      sortColumn: designTable.updatedAt,
                      idColumn: designTable.id,
                      cursor: cursorRow
                        ? { id: cursorRow.id, sortValue: cursorRow.updatedAt }
                        : undefined,
                    })
                  )
                )
                .orderBy(desc(designTable.updatedAt), designTable.id)
                .limit(query.limit + 1),
        ]);

        const { pageRows, nextCursor } = takeCursorPage(
          rows,
          query.limit,
          (row) => row.design.id
        );
        const items: Design[] = [];
        for (const row of pageRows) {
          const parsed = toDomainDesign(row.design, row.baseImage);
          if (parsed.isError()) return Result.Error(parsed.getError());
          items.push(parsed.get());
        }
        const parsedCursor = nextCursor ? toDesignId(nextCursor) : undefined;
        if (parsedCursor !== undefined && parsedCursor.isError()) {
          return Result.Error(rowError(nextCursor));
        }
        return Result.Ok({
          type: 'design_listed',
          page: {
            items,
            nextCursor: parsedCursor?.isOk() ? parsedCursor.get() : undefined,
            total: totals[0]?.count ?? 0,
          },
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async findOwned(input) {
      try {
        const row = await findOwnedRow(input.id, input.ownerId);
        if (!row) return Result.Ok({ type: 'design_not_found' });
        const parsed = toDomainDesign(row.design, row.baseImage);
        if (parsed.isError()) return Result.Error(parsed.getError());
        return Result.Ok({ type: 'design_found', design: parsed.get() });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async create(input) {
      try {
        const created = await db.transaction(async (tx) => {
          const [designRow] = await tx
            .insert(designTable)
            .values({
              id: input.id,
              ownerId: input.ownerId,
              name: input.name,
              baseImageId: input.baseImage.id,
              copiedFromDesignId: input.copiedFromDesignId,
            })
            .returning();
          const [imageRow] = await tx
            .insert(imageTable)
            .values(toImageValues(input.id, input.baseImage))
            .returning();
          return designRow && imageRow
            ? { design: designRow, baseImage: imageRow }
            : undefined;
        });
        if (!created)
          return Result.Error(dbError('design insert returned no row'));
        const parsed = toDomainDesign(created.design, created.baseImage);
        if (parsed.isError()) return Result.Error(parsed.getError());
        return Result.Ok({ type: 'design_created', design: parsed.get() });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async update(input) {
      try {
        const [updated] = await db
          .update(designTable)
          .set({
            ...(input.changes.name !== undefined
              ? { name: input.changes.name }
              : {}),
            ...(input.changes.archivedAt !== undefined
              ? { archivedAt: input.changes.archivedAt }
              : {}),
          })
          .where(
            and(
              eq(designTable.id, input.id),
              eq(designTable.ownerId, input.ownerId)
            )
          )
          .returning({ id: designTable.id });
        if (!updated) return Result.Ok({ type: 'design_not_found' });
        const row = await findOwnedRow(input.id, input.ownerId);
        if (!row) return Result.Ok({ type: 'design_not_found' });
        const parsed = toDomainDesign(row.design, row.baseImage);
        if (parsed.isError()) return Result.Error(parsed.getError());
        return Result.Ok({ type: 'design_updated', design: parsed.get() });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async findImage(imageId) {
      try {
        const [row] = await db
          .select({
            image: imageTable,
            designName: designTable.name,
            ownerId: designTable.ownerId,
          })
          .from(imageTable)
          .innerJoin(designTable, eq(designTable.id, imageTable.designId))
          .where(eq(imageTable.id, imageId))
          .limit(1);
        if (!row) return Result.Ok({ type: 'image_not_found' });
        const image = toDomainImage(row.image);
        const designName = toDesignName(row.designName);
        const ownerId = toUserId(row.ownerId);
        if (image.isError() || designName.isError() || ownerId.isError()) {
          return Result.Error(rowError(imageId));
        }
        return Result.Ok({
          type: 'image_found',
          image: image.get(),
          designName: designName.get(),
          ownerId: ownerId.get(),
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async addImage(input) {
      try {
        const [row] = await db
          .insert(imageTable)
          .values(toImageValues(input.designId, input.image))
          .returning();
        const image = row ? toDomainImage(row) : undefined;
        if (!image || image.isError()) {
          return Result.Error(rowError(input.image.id));
        }
        return Result.Ok({ type: 'image_added', image: image.get() });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
  };

  return observeRepository(repository, 'design');
};
