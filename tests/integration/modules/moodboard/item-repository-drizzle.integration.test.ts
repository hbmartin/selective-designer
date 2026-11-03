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

  const create = (id: string, category: string) =>
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

    await repository.setCutoutResult({
      versionId: versionId('i2-v1'),
      cutoutStatus: 'ready',
      cutoutKey: key('item-cutouts/i2-v1.png'),
    });
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
});
