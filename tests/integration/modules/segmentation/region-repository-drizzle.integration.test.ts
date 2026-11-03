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
  toRegionId,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { user as userTable } from '@/modules/kernel/infrastructure/db/schema';
import { unwrapParseResult } from '@/modules/kernel/testing';
import { createRegionRepository } from '@/modules/segmentation/testing';

const ownerId = unwrapParseResult(toUserId('owner-1'));
const designId = unwrapParseResult(toDesignId('design-1'));
const imageId = unwrapParseResult(toImageId('base-1'));
const key = (value: string) => unwrapParseResult(toObjectKey(value));
const regionId = (value: string) => unwrapParseResult(toRegionId(value));

describe('RegionRepositoryDrizzle', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;
  let repository: ReturnType<typeof createRegionRepository>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
    repository = createRegionRepository({ db: database.db });
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
        id: imageId,
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

  const region = (
    id: string,
    label: string,
    source: 'detection' | 'click' = 'detection'
  ) => ({
    id: regionId(id),
    designId,
    imageId,
    source,
    label,
    maskKey: key(`region-masks/${id}.png`),
    box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    score: 0.8,
    isSuggestion: false,
    carriedFromRegionId: null,
  });

  it('returns pending detection on an empty image and clears it after the last regions commit', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');
    expect(
      okValue(await repository.startDetection({ imageId, expiresAt }))
    ).toEqual({ type: 'detection_started' });
    expect(
      okValue(await repository.startDetection({ imageId, expiresAt }))
    ).toEqual({ type: 'detection_already_started' });
    expect(okValue(await repository.listByImage(imageId))).toEqual({
      type: 'regions_listed',
      regions: [],
      detectionExpiresAt: expiresAt,
    });
    await repository.insertMany([region('last-region', 'window')]);
    await repository.finishDetection(imageId);
    expect(okValue(await repository.listByImage(imageId))).toMatchObject({
      detectionExpiresAt: null,
      regions: [{ id: 'last-region' }],
    });
  });

  it('replaces detections per concept and keeps user regions', async () => {
    await repository.insertMany([region('u1', 'door', 'click')]);
    await repository.replaceDetections({
      imageId,
      concept: 'window',
      regions: [region('d1', 'window')],
    });
    await repository.replaceDetections({
      imageId,
      concept: 'window',
      regions: [region('d2', 'window'), region('d3', 'window')],
    });
    const listed = okValue(await repository.listByImage(imageId)).regions;
    expect(listed.map((r) => r.id).sort()).toEqual(['d2', 'd3', 'u1']);
    expect(listed.find((r) => r.id === 'd2')?.box).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
    });

    expect(
      okValue(
        await repository.update({
          regionId: regionId('u1'),
          label: 'Front door',
        })
      )
    ).toMatchObject({
      region: { label: 'Front door' },
    });
    await repository.remove(regionId('u1'));
    expect(okValue(await repository.findById(regionId('u1'))).type).toBe(
      'region_not_found'
    );
  });
});
