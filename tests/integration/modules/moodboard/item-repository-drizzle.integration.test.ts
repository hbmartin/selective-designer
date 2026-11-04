import { makeUserRow } from '@tests/server/db-fixtures';
import { createPgliteTestDatabase } from '@tests/server/pglite';
import { okValue } from '@tests/support/result';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { toDesignName } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/testing';
import {
  toDesignId,
  toImageId,
  toItemId,
  toItemVersionId,
  toObjectKey,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { user as userTable } from '@/modules/kernel/infrastructure/db/schema';
import { unwrapParseResult } from '@/modules/kernel/testing';
import { toItemCategory, toItemName } from '@/modules/moodboard';
import { createItemRepository } from '@/modules/moodboard/testing';

const ownerId = unwrapParseResult(toUserId('owner-1'));
const designId = unwrapParseResult(toDesignId('design-1'));
const key = (value: string) => unwrapParseResult(toObjectKey(value));
const versionId = (value: string) => unwrapParseResult(toItemVersionId(value));

describe('ItemRepositoryDrizzle', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;
  let repository: ReturnType<typeof createItemRepository>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
    repository = createItemRepository({ db: database.db });
  });

  beforeEach(async () => {
    await database.truncate();
    await database.db.insert(userTable).values(makeUserRow({ id: ownerId }));
    await createDesignRepository({ db: database.db }).create({
      id: designId,
      ownerId,
      name: okValue(toDesignName('Villa')),
      copiedFromDesignId: null,
      baseImage: {
        id: unwrapParseResult(toImageId('base-1')),
        kind: 'base',
        originalKey: key('base-images/b.png'),
        originalContentType: 'image/png',
        original: { width: 100, height: 100 },
        workingKey: key('working-images/b.png'),
        working: { width: 100, height: 100 },
      },
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  const create = (
    id: string,
    category: string,
    cutoutAttempt?: { id: string; startedAt: Date }
  ) =>
    repository.create({
      id: unwrapParseResult(toItemId(id)),
      designId,
      kind: 'product',
      name: okValue(toItemName(`Item ${id}`)),
      category: okValue(toItemCategory(category)),
      vendor: null,
      productUrl: null,
      version: {
        id: versionId(`${id}-v1`),
        photo: {
          key: key(`item-photos/${id}.png`),
          contentType: 'image/png',
          width: 10,
          height: 20,
        },
        cutoutKey: null,
        maskKey: null,
        cutoutStatus: 'pending',
        cutoutAttempt,
      },
    });

  it('creates, versions, lists and removes items', async () => {
    await create('i1', 'Lighting');
    await create('i2', 'Plants');

    const withVersion = okValue(
      await repository.addVersion({
        itemId: unwrapParseResult(toItemId('i1')),
        version: {
          id: versionId('i1-v2'),
          photo: {
            key: key('item-photos/i1.png'),
            contentType: 'image/png',
            width: 10,
            height: 20,
          },
          cutoutKey: key('item-cutouts/i1-v2.png'),
          maskKey: key('item-masks/i1-v2.png'),
          cutoutStatus: 'ready',
        },
      })
    );
    expect(withVersion).toMatchObject({
      type: 'item_found',
      item: {
        currentVersion: { id: 'i1-v2', number: 2, cutoutStatus: 'ready' },
      },
    });

    expect(
      okValue(await repository.findVersion(versionId('i1-v1')))
    ).toMatchObject({
      type: 'item_version_found',
      designId,
      version: { number: 1, cutoutStatus: 'pending' },
    });

    const legacy = await repository.finishCutoutAttempt({
      versionId: versionId('i2-v1'),
      attemptId: null,
      cutoutStatus: 'ready',
      cutoutKey: key('item-cutouts/i2-v1.png'),
    });
    expect(okValue(legacy).type).toBe('cutout_result_saved');
    await repository.remove({
      itemId: unwrapParseResult(toItemId('i1')),
      removedAt: new Date('2026-11-02T00:00:00.000Z'),
    });

    const listed = okValue(await repository.listByDesign(designId));
    expect(
      listed.items.map((item) => [item.id, item.currentVersion.cutoutStatus])
    ).toEqual([['i2', 'ready']]);
    expect(okValue(await repository.categoryUsage(ownerId)).usage).toEqual([
      { category: 'Plants', count: 1 },
    ]);
  });

  it.each(['failed', 'expired', 'legacy'] as const)(
    'claims one %s retry and only lets the current attempt publish',
    async (scenario) => {
      const originalAttempt =
        scenario === 'legacy'
          ? undefined
          : { id: 'first', startedAt: new Date('2026-11-03T12:00:00Z') };
      const { item } = okValue(
        await create('retry', 'Lighting', originalAttempt)
      );
      const id = item.currentVersion.id;
      const oldId = originalAttempt?.id ?? null;
      const originalStart =
        originalAttempt?.startedAt ?? item.currentVersion.createdAt;
      const cutoffMs = originalStart.getTime();
      const startedAt = new Date(cutoffMs + 30 * 60_000);
      const claim = (attemptId: string, expiredBeforeMs = cutoffMs) =>
        repository.claimCutoutAttempt({
          versionId: id,
          attemptId,
          expiredBeforeMs,
          startedAt,
        });
      const fail = (attemptId: string | null) =>
        repository.finishCutoutAttempt({
          versionId: id,
          attemptId,
          cutoutStatus: 'failed',
          cutoutKey: null,
        });
      const finish = (attemptId: string | null) =>
        repository.finishCutoutAttempt({
          versionId: id,
          attemptId,
          cutoutStatus: 'ready',
          cutoutKey: key(`item-cutouts/retry-v1/${attemptId}.png`),
        });

      expect(okValue(await claim('too-early', cutoffMs - 1)).type).toBe(
        'cutout_attempt_skipped'
      );
      if (scenario === 'failed') {
        expect(okValue(await fail(null)).type).toBe('cutout_attempt_skipped');
        expect(okValue(await fail(oldId)).type).toBe('cutout_result_saved');
      }

      const attempts = ['retry-a', 'retry-b'];
      const claims = await Promise.all(attempts.map((id) => claim(id)));
      expect(claims.map((claim) => okValue(claim).type).sort()).toEqual([
        'cutout_attempt_claimed',
        'cutout_attempt_skipped',
      ]);
      const winner =
        attempts[
          claims.findIndex(
            (claim) => okValue(claim).type === 'cutout_attempt_claimed'
          )
        ]!;
      expect(okValue(await finish(oldId)).type).toBe('cutout_attempt_skipped');
      expect(okValue(await fail(oldId)).type).toBe('cutout_attempt_skipped');
      expect(okValue(await claim('too-early-again')).type).toBe(
        'cutout_attempt_skipped'
      );
      expect(okValue(await finish(winner)).type).toBe('cutout_result_saved');
      expect(okValue(await fail(winner)).type).toBe('cutout_attempt_skipped');
      expect(okValue(await repository.findVersion(id))).toMatchObject({
        cutoutAttemptId: winner,
        version: {
          cutoutStatus: 'ready',
          cutoutAttemptStartedAt: startedAt,
          cutoutKey: `item-cutouts/retry-v1/${winner}.png`,
        },
      });
    }
  );
});
