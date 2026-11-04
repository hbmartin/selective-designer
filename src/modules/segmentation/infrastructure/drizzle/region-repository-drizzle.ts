import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { and, asc, eq, gt, isNull, lte, or } from 'drizzle-orm';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import {
  toDesignId,
  toImageId,
  toObjectKey,
  toRegionId,
} from '@/modules/kernel/domain/ids';
import { observeRepository } from '@/modules/kernel/infrastructure/db/observability';
import { image } from '@/modules/kernel/infrastructure/db/schema';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';
import type {
  DetectionRun,
  NewRegion,
  RegionRepository,
} from '@/modules/segmentation/application/ports/ports';
import {
  type Region,
  type RegionSource,
  regionSources,
} from '@/modules/segmentation/domain/region';

import {
  activeDetection,
  region as regionTable,
  type RegionRow,
} from './schema';

const rowError = (cause: unknown) =>
  new AppError({
    code: 'REGION_ROW_INVALID',
    category: 'system',
    status: 500,
    message: 'Region row contains invalid data',
    cause,
  });
const dbError = (cause: unknown) =>
  new AppError({
    code: 'REGION_REPOSITORY_ERROR',
    category: 'system',
    status: 500,
    message: 'Region persistence failed',
    cause,
  });

const isSource = (value: string): value is RegionSource =>
  (regionSources as readonly string[]).includes(value);

const toRegion = (row: RegionRow): BoxedResult<Region, AppError> => {
  const id = toRegionId(row.id);
  const designId = toDesignId(row.designId);
  const imageId = toImageId(row.imageId);
  const maskKey = toObjectKey(row.maskKey);
  const carried = row.carriedFromRegionId
    ? toRegionId(row.carriedFromRegionId)
    : undefined;
  if (
    id.isError() ||
    designId.isError() ||
    imageId.isError() ||
    maskKey.isError() ||
    (carried !== undefined && carried.isError()) ||
    !isSource(row.source)
  ) {
    return Result.Error(rowError(row.id));
  }
  return Result.Ok({
    id: id.get(),
    designId: designId.get(),
    imageId: imageId.get(),
    source: row.source,
    label: row.label,
    maskKey: maskKey.get(),
    box: row.box,
    score: row.score,
    isSuggestion: row.isSuggestion,
    carriedFromRegionId: carried?.isOk() ? carried.get() : null,
    createdAt: row.createdAt,
  });
};

const toValues = (input: NewRegion) => ({
  id: input.id,
  designId: input.designId,
  imageId: input.imageId,
  source: input.source,
  label: input.label,
  maskKey: input.maskKey,
  box: input.box,
  score: input.score,
  isSuggestion: input.isSuggestion,
  carriedFromRegionId: input.carriedFromRegionId,
});

const ownedDetection = (run: DetectionRun) =>
  and(
    eq(activeDetection.imageId, run.imageId),
    run.runId === null
      ? isNull(activeDetection.runId)
      : eq(activeDetection.runId, run.runId)
  );

/** Lock the lease row in the same transaction as publishing region changes. */
const lockDetection = async (db: DbLike, run: DetectionRun) => {
  const [row] = await db
    .select({ progress: activeDetection.progress })
    .from(activeDetection)
    .where(
      and(
        ownedDetection(run),
        eq(activeDetection.failed, false),
        run.now ? gt(activeDetection.expiresAt, run.now) : undefined
      )
    )
    .for('update');
  return row;
};

export const createRegionRepository = ({
  db,
}: {
  db: DbLike;
}): RegionRepository => {
  const parseAll = (rows: RegionRow[]): BoxedResult<Region[], AppError> => {
    const regions: Region[] = [];
    for (const row of rows) {
      const parsed = toRegion(row);
      if (parsed.isError()) return Result.Error(parsed.getError());
      regions.push(parsed.get());
    }
    return Result.Ok(regions);
  };

  const repository: RegionRepository = {
    async listByImage(imageId) {
      try {
        const rows = await db
          .select({
            region: regionTable,
            detectionExpiresAt: activeDetection.expiresAt,
            detectionState: {
              failed: activeDetection.failed,
              runId: activeDetection.runId,
              progress: activeDetection.progress,
            },
          })
          .from(image)
          .leftJoin(regionTable, eq(regionTable.imageId, image.id))
          .leftJoin(activeDetection, eq(activeDetection.imageId, image.id))
          .where(eq(image.id, imageId))
          .orderBy(asc(regionTable.createdAt), asc(regionTable.id));
        const parsed = parseAll(
          rows.flatMap((row) => (row.region ? [row.region] : []))
        );
        if (parsed.isError()) return Result.Error(parsed.getError());
        return Result.Ok({
          type: 'regions_listed',
          regions: parsed.get(),
          detectionExpiresAt: rows[0]?.detectionExpiresAt ?? null,
          ...(rows[0]?.detectionState
            ? { detectionState: rows[0].detectionState }
            : {}),
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async startDetection(input) {
      try {
        const [started] = await db
          .insert(activeDetection)
          .values({
            imageId: input.imageId,
            runId: input.runId,
            expiresAt: new Date(input.expiresAtMs),
            progress: input.progress,
          })
          .onConflictDoNothing({ target: activeDetection.imageId })
          .returning({ imageId: activeDetection.imageId });
        return Result.Ok(
          started
            ? { type: 'detection_started' }
            : { type: 'detection_already_started' }
        );
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async resumeDetection(input) {
      try {
        const [claimed] = await db
          .update(activeDetection)
          .set({
            runId: input.runId,
            failed: false,
            expiresAt: new Date(input.expiresAtMs),
            ...(input.legacyProgress ? { progress: input.legacyProgress } : {}),
          })
          .where(
            and(
              ownedDetection(input.previous),
              or(
                eq(activeDetection.failed, true),
                lte(activeDetection.expiresAt, input.now)
              )
            )
          )
          .returning({ imageId: activeDetection.imageId });
        return Result.Ok({
          type: claimed ? 'detection_started' : 'detection_already_started',
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async prepareDetection({ concepts, ...run }) {
      try {
        return await db.transaction(async (tx) => {
          const owned = await lockDetection(tx, run);
          if (!owned?.progress)
            return Result.Ok({ type: 'detection_superseded' } as const);
          const progress = owned.progress;
          if (progress.concepts !== null)
            return Result.Ok({ type: 'detection_prepared', progress } as const);
          const prepared = { ...progress, concepts };
          await tx
            .update(activeDetection)
            .set({ progress: prepared })
            .where(ownedDetection(run));
          return Result.Ok({
            type: 'detection_prepared',
            progress: prepared,
          } as const);
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async finalizeDetection(run) {
      try {
        return await db.transaction(async (tx) => {
          const owned = await lockDetection(tx, run);
          if (!owned?.progress)
            return Result.Ok({ type: 'detection_superseded' } as const);
          const { carryOverCompleted, concepts, completedConcepts } =
            owned.progress;
          if (
            carryOverCompleted &&
            concepts?.every((concept) => completedConcepts.includes(concept))
          ) {
            await tx.delete(activeDetection).where(ownedDetection(run));
            return Result.Ok({ type: 'detection_finished' } as const);
          }
          await tx
            .update(activeDetection)
            .set({ failed: true })
            .where(ownedDetection(run));
          return Result.Ok({ type: 'detection_failed' } as const);
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async finishDetection(run) {
      try {
        await db
          .delete(activeDetection)
          .where(
            and(
              ownedDetection(run),
              run.now ? gt(activeDetection.expiresAt, run.now) : undefined
            )
          );
        return Result.Ok({ type: 'detection_finished' });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async findById(regionId) {
      try {
        const [row] = await db
          .select()
          .from(regionTable)
          .where(eq(regionTable.id, regionId))
          .limit(1);
        if (!row) return Result.Ok({ type: 'region_not_found' });
        const parsed = toRegion(row);
        if (parsed.isError()) return Result.Error(parsed.getError());
        return Result.Ok({ type: 'region_found', region: parsed.get() });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async insertMany(regions, run) {
      try {
        if (run) {
          return await db.transaction(async (tx) => {
            const owned = await lockDetection(tx, run);
            if (!owned)
              return Result.Ok({ type: 'detection_superseded' } as const);
            if (owned.progress?.carryOverCompleted)
              return Result.Ok({ type: 'regions_saved' } as const);

            if (regions.length > 0)
              await tx.insert(regionTable).values(regions.map(toValues));
            if (owned.progress) {
              await tx
                .update(activeDetection)
                .set({
                  progress: { ...owned.progress, carryOverCompleted: true },
                })
                .where(ownedDetection(run));
            }
            return Result.Ok({ type: 'regions_saved' } as const);
          });
        }
        if (regions.length > 0)
          await db.insert(regionTable).values(regions.map(toValues));
        return Result.Ok({ type: 'regions_saved' });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async replaceDetections(input) {
      try {
        return await db.transaction(async (tx) => {
          const run =
            input.runId === undefined
              ? null
              : {
                  imageId: input.imageId,
                  runId: input.runId,
                  now: input.now,
                };
          const owned = run ? await lockDetection(tx, run) : undefined;
          if (run && !owned)
            return Result.Ok({ type: 'detection_superseded' } as const);
          if (owned?.progress?.completedConcepts.includes(input.concept))
            return Result.Ok({ type: 'regions_saved' } as const);
          await tx
            .delete(regionTable)
            .where(
              and(
                eq(regionTable.imageId, input.imageId),
                eq(regionTable.source, 'detection'),
                eq(regionTable.label, input.concept)
              )
            );
          if (input.regions.length > 0) {
            await tx.insert(regionTable).values(input.regions.map(toValues));
          }
          if (run && owned?.progress) {
            await tx
              .update(activeDetection)
              .set({
                progress: {
                  ...owned.progress,
                  completedConcepts: [
                    ...owned.progress.completedConcepts,
                    input.concept,
                  ],
                },
              })
              .where(ownedDetection(run));
          }
          return Result.Ok({ type: 'regions_saved' } as const);
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async update(input) {
      try {
        const [row] = await db
          .update(regionTable)
          .set({
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.isSuggestion !== undefined
              ? { isSuggestion: input.isSuggestion }
              : {}),
          })
          .where(eq(regionTable.id, input.regionId))
          .returning();
        if (!row) return Result.Ok({ type: 'region_not_found' });
        const parsed = toRegion(row);
        if (parsed.isError()) return Result.Error(parsed.getError());
        return Result.Ok({ type: 'region_found', region: parsed.get() });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async remove(regionId) {
      try {
        await db.delete(regionTable).where(eq(regionTable.id, regionId));
        return Result.Ok({ type: 'region_removed' });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
  };
  return observeRepository(repository, 'region');
};
