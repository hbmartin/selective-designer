import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import {
  toDesignId,
  toImageId,
  toObjectKey,
  toRegionId,
} from '@/modules/kernel/domain/ids';
import { createTransactionRunner } from '@/modules/kernel/infrastructure/db/client';
import { getDatabaseErrorCode } from '@/modules/kernel/infrastructure/db/db-error-details';
import { observeRepository } from '@/modules/kernel/infrastructure/db/observability';
import {
  type DbLike,
  type DbTransaction,
  isRootDatabase,
} from '@/modules/kernel/infrastructure/db/types';
import type {
  DetectionOmission,
  DetectionRun,
  NewRegion,
  RegionRepository,
} from '@/modules/segmentation/application/ports/ports';
import { detectionRunFor } from '@/modules/segmentation/domain/detection-run';
import {
  isDetectionConceptSettled,
  type Region,
  type RegionSource,
  regionSources,
} from '@/modules/segmentation/domain/region';

import {
  activeDetection,
  region as regionTable,
  type RegionRow,
} from './schema';
import { RegionWriteError } from '../../domain/region-write-error';

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

const regionWriteError = (cause: unknown) =>
  new RegionWriteError(
    ['23502', '23503', '23505', '23514'].includes(
      getDatabaseErrorCode(cause) ?? ''
    )
      ? 'rejected'
      : 'unknown',
    cause
  );

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
      : eq(activeDetection.runId, run.runId),
    run.workerId === undefined
      ? undefined
      : eq(activeDetection.workerId, run.workerId)
  );

const runPhase = (run: DetectionRun) =>
  run.workerId === undefined
    ? isNull(activeDetection.phase)
    : eq(activeDetection.phase, 'running');

const lockDetection = async (db: DbLike, run: DetectionRun) => {
  const [row] = await db
    .select({ progress: activeDetection.progress })
    .from(activeDetection)
    .where(
      and(
        ownedDetection(run),
        runPhase(run),
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
  const transact = <T>(work: (tx: DbTransaction) => Promise<T>) =>
    isRootDatabase(db)
      ? createTransactionRunner(db).run(work)
      : db.transaction(work);
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
        // Read the regions and their display status from the same snapshot.
        // The anchor also returns the status when no regions exist yet.
        const rows = await db
          .select({
            region: regionTable,
            expiresAt: activeDetection.expiresAt,
            failed: activeDetection.failed,
            phase: activeDetection.phase,
            omissions: sql<DetectionOmission[] | null>`
              ${activeDetection.progress}->'omissions'
            `,
          })
          .from(sql`(select 1) as requested_image`)
          .leftJoin(regionTable, eq(regionTable.imageId, imageId))
          .leftJoin(activeDetection, eq(activeDetection.imageId, imageId))
          .orderBy(asc(regionTable.createdAt), asc(regionTable.id));
        const parsed = parseAll(
          rows.flatMap(({ region }) => (region ? [region] : []))
        );
        if (parsed.isError()) return Result.Error(parsed.getError());
        const lease = rows[0];
        return Result.Ok({
          type: 'regions_listed',
          regions: parsed.get(),
          detection:
            lease?.expiresAt && lease.failed !== null
              ? {
                  type: 'detection_recorded',
                  expiresAt: lease.expiresAt,
                  failed: lease.failed,
                  phase: lease.phase,
                  omissions: lease.omissions ?? [],
                }
              : { type: 'no_detection' },
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async matchImageWrite(imageId, imageWriteId) {
      try {
        const [row] = await db
          .select({ id: activeDetection.imageId })
          .from(activeDetection)
          .where(
            and(
              eq(activeDetection.imageId, imageId),
              eq(activeDetection.imageWriteId, imageWriteId)
            )
          )
          .limit(1);
        return Result.Ok({
          type: row ? 'image_write_matched' : 'image_write_not_matched',
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async findDetection(imageId) {
      try {
        const [lease] = await db
          .select()
          .from(activeDetection)
          .where(eq(activeDetection.imageId, imageId))
          .limit(1);
        return Result.Ok(
          lease
            ? { ...lease, type: 'detection_lease' }
            : { type: 'no_detection' }
        );
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async detectionLabels(imageId) {
      try {
        const rows = await db
          .selectDistinct({ label: regionTable.label })
          .from(regionTable)
          .where(
            and(
              eq(regionTable.imageId, imageId),
              eq(regionTable.source, 'detection')
            )
          );
        return Result.Ok(rows.map(({ label }) => label));
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async startDetection(input) {
      try {
        const [started] = await db
          .insert(activeDetection)
          .values({
            imageWriteId: input.imageWriteId,
            imageId: input.imageId,
            runId: input.runId,
            expiresAt: new Date(input.expiresAtMs),
            progress: input.progress,
            phase: input.phase,
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
            phase: 'queued',
            workerId: null,
            ...(input.progress ? { progress: input.progress } : {}),
          })
          .where(
            and(
              ownedDetection(input.previous),
              or(
                isNull(activeDetection.phase),
                inArray(activeDetection.phase, [
                  'copying',
                  'ready',
                  'queued',
                  'running',
                ])
              ),
              input.dispatch.previousPhase === null
                ? isNull(activeDetection.phase)
                : eq(activeDetection.phase, input.dispatch.previousPhase),
              input.dispatch.initial
                ? undefined
                : or(
                    eq(activeDetection.failed, true),
                    eq(activeDetection.phase, 'ready'),
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
    async claimDetection({ expiresAt, ...run }) {
      try {
        const [claimed] = await db
          .update(activeDetection)
          .set({ phase: 'running', workerId: run.workerId, expiresAt })
          .where(
            and(
              ownedDetection({ imageId: run.imageId, runId: run.runId }),
              eq(activeDetection.phase, 'queued'),
              eq(activeDetection.failed, false),
              gt(activeDetection.expiresAt, run.now)
            )
          )
          .returning({ imageId: activeDetection.imageId });
        if (claimed) return Result.Ok({ type: 'detection_started' });
        const [replayed] = await db
          .select({ imageId: activeDetection.imageId })
          .from(activeDetection)
          .where(
            and(
              ownedDetection(run),
              runPhase(run),
              eq(activeDetection.failed, false),
              gt(activeDetection.expiresAt, run.now)
            )
          );
        return Result.Ok({
          type: replayed ? 'detection_started' : 'detection_already_started',
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async failDispatch(run) {
      try {
        await db
          .update(activeDetection)
          .set({ failed: true })
          .where(and(ownedDetection(run), eq(activeDetection.phase, 'queued')));
        return Result.Ok({ type: 'dispatch_failure_recorded' });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async omitConcept({ concept, reason, ...run }) {
      try {
        return await transact(async (tx) => {
          const owned = await lockDetection(tx, run);
          if (!owned?.progress)
            return Result.Ok({ type: 'detection_superseded' } as const);
          if (isDetectionConceptSettled(owned.progress, concept))
            return Result.Ok({
              type: 'detection_concept_already_completed',
            } as const);
          await tx
            .update(activeDetection)
            .set({
              progress: {
                ...owned.progress,
                omissions: [
                  ...(owned.progress.omissions ?? []),
                  { concept, reason },
                ],
              },
            })
            .where(ownedDetection(run));
          return Result.Ok({ type: 'regions_saved' } as const);
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },

    async prepareDetection({ concepts, ...run }) {
      try {
        return await transact(async (tx) => {
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
        return await transact(async (tx) => {
          const owned = await lockDetection(tx, run);
          if (!owned?.progress)
            return Result.Ok({ type: 'detection_superseded' } as const);
          const { carryOverCompleted, concepts, omissions } = owned.progress;
          if (
            carryOverCompleted &&
            concepts?.every((concept) =>
              isDetectionConceptSettled(owned.progress, concept)
            )
          ) {
            if (omissions?.length)
              await tx
                .update(activeDetection)
                .set({
                  phase: 'omissions',
                  workerId: null,
                  completedAt: run.now,
                  failed: false,
                })
                .where(ownedDetection(run));
            else
              await tx
                .update(activeDetection)
                .set({
                  phase: 'completed',
                  workerId: null,
                  completedAt: run.now,
                  failed: false,
                })
                .where(ownedDetection(run));
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
          .update(activeDetection)
          .set({
            phase: 'completed',
            workerId: null,
            completedAt: run.now,
            failed: false,
          })
          .where(
            and(
              ownedDetection(run),
              isNull(activeDetection.phase),
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
    async unreferencedMaskKeys(keys) {
      if (keys.length === 0)
        return Result.Ok({ type: 'unreferenced_mask_keys', keys: [] });
      try {
        const rows = await db
          .selectDistinct({ key: regionTable.maskKey })
          .from(regionTable)
          .where(inArray(regionTable.maskKey, [...keys]));
        const referenced = new Set(rows.map(({ key }) => key));
        return Result.Ok({
          type: 'unreferenced_mask_keys',
          keys: keys.filter((key) => !referenced.has(key)),
        });
      } catch (error) {
        return Result.Error(dbError(error));
      }
    },
    async insertMany(regions, run) {
      try {
        if (run) {
          return await transact(async (tx) => {
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
        return Result.Error(regionWriteError(error));
      }
    },
    async replaceDetections(input) {
      const identity = detectionRunFor(input.imageId, input);
      if (identity.isError()) return Result.Error(identity.getError());
      const run = identity.get();
      try {
        return await transact(async (tx) => {
          const owned = run
            ? await lockDetection(tx, { ...run, now: input.now })
            : undefined;
          if (run && !owned)
            return Result.Ok({ type: 'detection_superseded' } as const);
          if (isDetectionConceptSettled(owned?.progress, input.concept))
            return Result.Ok({
              type: 'detection_concept_already_completed',
            } as const);
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
        return Result.Error(regionWriteError(error));
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
