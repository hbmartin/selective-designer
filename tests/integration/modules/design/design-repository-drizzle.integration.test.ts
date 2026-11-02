import { makeUserRow } from '@tests/server/db-fixtures';
import { createPgliteTestDatabase } from '@tests/server/pglite';
import { okValue } from '@tests/support/result';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { toDesignName } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/testing';
import {
  toDesignId,
  toImageId,
  toObjectKey,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { user as userTable } from '@/modules/kernel/infrastructure/db/schema';
import { unwrapParseResult } from '@/modules/kernel/testing';

const ownerId = unwrapParseResult(toUserId('owner-1'));
const otherId = unwrapParseResult(toUserId('owner-2'));
const designId = (value: string) => unwrapParseResult(toDesignId(value));
const imageId = (value: string) => unwrapParseResult(toImageId(value));
const key = (value: string) => unwrapParseResult(toObjectKey(value));
const name = (value: string) => okValue(toDesignName(value));

const newBaseImage = (id: string) => ({
  id: imageId(id),
  kind: 'base' as const,
  originalKey: key(`base-images/${id}.png`),
  originalContentType: 'image/png',
  original: { width: 4000, height: 3000 },
  workingKey: key(`working-images/${id}.png`),
  working: { width: 2048, height: 1536 },
});

describe('DesignRepositoryDrizzle', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;
  let repository: ReturnType<typeof createDesignRepository>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
    repository = createDesignRepository({ db: database.db });
  });

  beforeEach(async () => {
    await database.truncate();
    await database.db
      .insert(userTable)
      .values([
        makeUserRow({ id: ownerId, email: 'one@example.com' }),
        makeUserRow({ id: otherId, email: 'two@example.com' }),
      ]);
  });

  afterAll(async () => {
    await database?.close();
  });

  const create = (id: string, designName: string, owner = ownerId) =>
    repository.create({
      id: designId(id),
      ownerId: owner,
      name: name(designName),
      copiedFromDesignId: null,
      baseImage: newBaseImage(`img-${id}`),
    });

  it('creates a design with its base image and finds it only for the owner', async () => {
    const created = okValue(await create('d1', 'Lakeside Villa'));
    expect(created.design).toMatchObject({
      id: 'd1',
      name: 'Lakeside Villa',
      baseImage: {
        id: 'img-d1',
        designId: 'd1',
        kind: 'base',
        original: { width: 4000, height: 3000 },
        working: { width: 2048, height: 1536 },
      },
    });

    expect(
      okValue(await repository.findOwned({ id: designId('d1'), ownerId })).type
    ).toBe('design_found');
    expect(
      okValue(
        await repository.findOwned({ id: designId('d1'), ownerId: otherId })
      ).type
    ).toBe('design_not_found');
  });

  it('lists by owner, archive state and search with cursor pagination', async () => {
    await create('d1', 'Lakeside Villa');
    await create('d2', 'Mountain Lodge');
    await create('d3', 'Lake House');
    await create('d4', 'Other owner lake', otherId);
    await repository.update({
      id: designId('d2'),
      ownerId,
      changes: { archivedAt: new Date('2026-11-02T00:00:00.000Z') },
    });

    const lake = okValue(
      await repository.list({
        ownerId,
        archived: false,
        searchTerm: 'lake',
        cursor: undefined,
        limit: 1,
      })
    );
    expect(lake.page.total).toBe(2);
    expect(lake.page.items).toHaveLength(1);
    expect(lake.page.nextCursor).toBeDefined();

    const next = okValue(
      await repository.list({
        ownerId,
        archived: false,
        searchTerm: 'lake',
        cursor: lake.page.nextCursor,
        limit: 1,
      })
    );
    expect(next.page.items).toHaveLength(1);
    expect(next.page.nextCursor).toBeUndefined();
    expect(
      new Set([...lake.page.items, ...next.page.items].map((d) => d.id))
    ).toEqual(new Set(['d1', 'd3']));

    const archived = okValue(
      await repository.list({
        ownerId,
        archived: true,
        searchTerm: '',
        cursor: undefined,
        limit: 10,
      })
    );
    expect(archived.page.items.map((d) => d.id)).toEqual(['d2']);
  });

  it('renames only owned designs and resolves images with their owner', async () => {
    await create('d1', 'Lakeside Villa');
    expect(
      okValue(
        await repository.update({
          id: designId('d1'),
          ownerId: otherId,
          changes: { name: name('Stolen') },
        })
      ).type
    ).toBe('design_not_found');

    const renamed = okValue(
      await repository.update({
        id: designId('d1'),
        ownerId,
        changes: { name: name('Lakeside Villa v2') },
      })
    );
    expect(renamed).toMatchObject({ design: { name: 'Lakeside Villa v2' } });

    const added = okValue(
      await repository.addImage({
        designId: designId('d1'),
        image: { ...newBaseImage('result-1'), kind: 'result' },
      })
    );
    expect(added.image.kind).toBe('result');

    expect(
      okValue(await repository.findImage(imageId('result-1')))
    ).toMatchObject({
      type: 'image_found',
      designName: 'Lakeside Villa v2',
      ownerId,
      image: { kind: 'result', designId: 'd1' },
    });
    expect(okValue(await repository.findImage(imageId('missing'))).type).toBe(
      'image_not_found'
    );
  });
});
