import { Result } from '@bloodyowl/boxed';
import { makeUserRow } from '@tests/server/db-fixtures';
import { createPgliteTestDatabase } from '@tests/server/pglite';
import { okValue } from '@tests/support/result';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { writeImageWithDetection } from '@/composition/image-detection-intent';
import { toDesignName } from '@/modules/design';
import { createDesignRepository } from '@/modules/design/testing';
import {
  AppError,
  toDesignId,
  toGeneratedId,
  toImageId,
  toObjectKey,
  toUserId,
} from '@/modules/kernel';
import {
  createMigrationDbClient,
  migrateDatabase,
} from '@/modules/kernel/infrastructure/db/migrate';
import { user as userTable } from '@/modules/kernel/infrastructure/db/schema';
import { createRegionRepository } from '@/modules/segmentation/testing';

const ownerId = okValue(toUserId('owner'));
const designId = okValue(toDesignId('design'));
const image = (id = 'result') => ({
  id: okValue(toImageId(id)),
  designId,
  kind: 'result' as const,
  originalKey: okValue(toObjectKey('renders/result.png')),
  originalContentType: 'image/png',
  original: { width: 100, height: 100 },
  workingKey: okValue(toObjectKey('renders/result.png')),
  working: { width: 100, height: 100 },
});

const nativeUrl = process.env.RECOVERY_TEST_DATABASE_URL;
// The socket emulator cannot safely replay SQL error responses. Its path
// rolls back real transactions with driver-shaped failures; native PostgreSQL
// uses a trigger to raise the same errors inside the server.
async function installIntentFault(
  db: Awaited<ReturnType<typeof createPgliteTestDatabase>>['db'],
  code: string,
  failures: number
) {
  if (!nativeUrl) {
    const transact = db.$runInTransaction!;
    let remaining = failures;
    const spy = vi
      .spyOn(db, '$runInTransaction')
      .mockImplementation((work, options) =>
        transact(async (tx) => {
          const result = await work(tx);
          if (remaining-- > 0)
            throw new AppError({
              code: 'WRAPPED_DRIVER_ERROR',
              category: 'system',
              status: 500,
              cause: new Error('query failed', {
                cause: Object.assign(new Error('injected rollback'), { code }),
              }),
            });
          return result;
        }, options)
      );
    return async () => {
      spy.mockRestore();
    };
  }
  await db.$client.query('CREATE SEQUENCE image_write_fault_sequence');
  await db.$client
    .query(`CREATE FUNCTION fail_image_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF nextval('image_write_fault_sequence') <= ${failures} THEN RAISE EXCEPTION 'injected rollback' USING ERRCODE = '${code}'; END IF;
    RETURN NEW; END $$`);
  await db.$client.query(
    'CREATE TRIGGER image_write_fault BEFORE INSERT ON active_detection FOR EACH ROW EXECUTE FUNCTION fail_image_intent()'
  );
  return async () => {
    await db.$client.query(
      'DROP TRIGGER IF EXISTS image_write_fault ON active_detection'
    );
    await db.$client.query('DROP FUNCTION IF EXISTS fail_image_intent()');
    await db.$client.query(
      'DROP SEQUENCE IF EXISTS image_write_fault_sequence'
    );
  };
}

describe('atomic image and detection writes', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;
  beforeAll(async () => {
    if (nativeUrl) {
      const target = new URL(nativeUrl);
      if (
        !['postgres:', 'postgresql:'].includes(target.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
        !target.pathname.startsWith('/selective_designer_recovery_test_') ||
        target.search
      )
        throw new Error(
          'RECOVERY_TEST_DATABASE_URL must target a direct disposable loopback selective_designer_recovery_test_ database.'
        );
      const migration = await createMigrationDbClient({
        databaseUrl: nativeUrl,
        driver: 'node-pg',
      });
      try {
        await migrateDatabase(migration);
      } finally {
        await migration.$close();
      }
    }
    database = await createPgliteTestDatabase(
      nativeUrl ? { databaseUrl: nativeUrl } : undefined
    );
  });
  beforeEach(async () => {
    await database.truncate();
    await database.db.insert(userTable).values(makeUserRow({ id: ownerId }));
    await createDesignRepository({ db: database.db }).create({
      id: designId,
      ownerId,
      name: okValue(toDesignName('Villa')),
      copiedFromDesignId: null,
      baseImage: { ...image('base'), kind: 'base' },
    });
  });
  afterAll(async () => {
    await database?.close();
  });

  const setup = () => {
    const createId = vi.fn(() => toGeneratedId('stable-write'));
    const kernel = {
      db: database.db,
      clock: { now: () => new Date('2026-11-05T00:00:00Z') },
      idGenerator: { createId },
    };
    const save = vi.fn(
      (repository: ReturnType<typeof createDesignRepository>) =>
        repository.addImage({ designId, image: image() })
    );
    const wait = vi.fn(async () => {});
    return {
      kernel,
      save,
      createId,
      wait,
      input: { image: image(), carryFromImageId: null, save },
    };
  };

  it.each(['40001', '40P01', '55P03'])(
    'retries complete transactions after PostgreSQL %s rollbacks',
    async (code) => {
      const cleanup = await installIntentFault(database.db, code, 2);
      const ctx = setup();
      try {
        const result = await writeImageWithDetection(ctx.kernel, ctx.input, {
          delay: ctx.wait,
        });
        expect(okValue(result).image.id).toBe(image().id);
        expect(ctx.save).toHaveBeenCalledTimes(3);
        expect(ctx.createId).toHaveBeenCalledOnce();
        expect(ctx.wait.mock.calls).toEqual([[100], [300]]);
        expect(
          okValue(
            await createRegionRepository({ db: database.db }).matchImageWrite(
              image().id,
              'stable-write'
            )
          )
        ).toEqual({ type: 'image_write_matched' });
        const rows = okValue(
          await createDesignRepository({ db: database.db }).listImages({
            designId,
            kind: 'result',
          })
        );
        expect(rows.images).toHaveLength(1);
      } finally {
        await cleanup();
      }
    }
  );

  it('rolls back the image and intent after retry exhaustion', async () => {
    const cleanup = await installIntentFault(database.db, '40001', 3);
    const ctx = setup();
    try {
      expect(
        (
          await writeImageWithDetection(ctx.kernel, ctx.input, {
            delay: ctx.wait,
          })
        ).isError()
      ).toBe(true);
      expect(ctx.save).toHaveBeenCalledTimes(3);
      expect(ctx.wait.mock.calls).toEqual([[100], [300]]);
      expect(
        okValue(
          await createDesignRepository({ db: database.db }).findImage(
            image().id
          )
        ).type
      ).toBe('image_not_found');
      expect(
        okValue(
          await createRegionRepository({ db: database.db }).findDetection(
            image().id
          )
        ).type
      ).toBe('no_detection');
    } finally {
      await cleanup();
    }
  });

  it('does not retry a constraint rejection or a configuration failure', async () => {
    const cleanup = await installIntentFault(database.db, '23514', 1);
    const ctx = setup();
    try {
      expect(
        (
          await writeImageWithDetection(ctx.kernel, ctx.input, {
            delay: ctx.wait,
          })
        ).isError()
      ).toBe(true);
      expect(ctx.save).toHaveBeenCalledOnce();
      expect(ctx.wait).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
    const error = new AppError({
      code: 'CONFIGURATION_ERROR',
      category: 'system',
      status: 500,
    });
    ctx.save.mockResolvedValue(Result.Error(error));
    const result = await writeImageWithDetection(ctx.kernel, ctx.input, {
      delay: ctx.wait,
    });
    expect(result.isError() && result.getError()).toBe(error);
    expect(ctx.wait).not.toHaveBeenCalled();
  });

  it.each([undefined, 'EPIPE', '08006'])(
    'reconciles a committed image after a lost commit response with code %s',
    async (code) => {
      const ctx = setup();
      const transact = database.db.$runInTransaction!;
      const lost = Object.assign(new Error('commit response lost'), { code });
      let first = true;
      const spy = vi
        .spyOn(database.db, '$runInTransaction')
        .mockImplementation(async (work, options) => {
          const result = await transact(work, options);
          if (first) {
            first = false;
            throw lost;
          }
          return result;
        });
      try {
        expect(
          okValue(
            await writeImageWithDetection(ctx.kernel, ctx.input, {
              delay: ctx.wait,
            })
          ).image.id
        ).toBe(image().id);
        expect(ctx.save).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledTimes(2);
        expect(ctx.wait).not.toHaveBeenCalled();
        expect(spy.mock.calls[1]?.[1]).toEqual({
          isolationLevel: 'repeatable read',
          accessMode: 'read only',
        });
      } finally {
        spy.mockRestore();
      }
    }
  );

  it.each([
    'rollback',
    'unavailable',
    'wrong identity',
    'wrong image',
  ] as const)(
    'preserves the original failure when reconciliation finds %s',
    async (scenario) => {
      const ctx = setup();
      if (scenario === 'wrong image')
        ctx.input.image = { ...image(), working: { width: 101, height: 100 } };
      const transact = database.db.$runInTransaction!;
      const lost = new Error('original commit diagnostic');
      let first = true;
      const spy = vi
        .spyOn(database.db, '$runInTransaction')
        .mockImplementation(async (work, options) => {
          if (first) {
            first = false;
            if (scenario === 'rollback')
              return transact(async (tx) => {
                await work(tx);
                throw lost;
              }, options);
            await transact(work, options);
            if (scenario === 'wrong identity')
              await database.db.$client.query(
                'UPDATE active_detection SET "imageWriteId" = \'another-write\' WHERE "imageId" = \'result\''
              );
            throw lost;
          }
          if (scenario === 'unavailable')
            throw new Error('reconciliation unavailable');
          return transact(work, options);
        });
      try {
        const result = await writeImageWithDetection(ctx.kernel, ctx.input, {
          delay: ctx.wait,
        });
        expect(result.isError() && result.getError().cause).toBe(lost);
        expect(ctx.save).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledTimes(4);
        expect(ctx.wait.mock.calls).toEqual([[100], [300]]);
      } finally {
        spy.mockRestore();
      }
    }
  );
});
