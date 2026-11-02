import { makeUserRow } from '@tests/server/db-fixtures';
import { createPgliteTestDatabase } from '@tests/server/pglite';
import { okValue } from '@tests/support/result';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  toObjectKey,
  toProviderCallId,
  toUserId,
} from '@/modules/kernel/domain/ids';
import { createProviderCallLog } from '@/modules/kernel/infrastructure/db/provider-call-log-drizzle';
import { user as userTable } from '@/modules/kernel/infrastructure/db/schema';
import { providerCall } from '@/modules/kernel/infrastructure/db/schema/provider-call';
import { createUploadIntentStore } from '@/modules/kernel/infrastructure/db/upload-intent-store-drizzle';
import { unwrapParseResult } from '@/modules/kernel/testing';

const userId = unwrapParseResult(toUserId('user-1'));
const otherUserId = unwrapParseResult(toUserId('user-2'));
const objectKey = unwrapParseResult(toObjectKey('base-images/abc.png'));
const issuedAt = new Date('2026-11-02T12:00:00.000Z');
const expiresAt = new Date('2026-11-02T12:30:00.000Z');

describe('upload intent store (drizzle)', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;
  let store: ReturnType<typeof createUploadIntentStore>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
    store = createUploadIntentStore({ db: database.db });
  });

  beforeEach(async () => {
    await database.truncate();
    await database.db
      .insert(userTable)
      .values([
        makeUserRow({ id: userId, email: 'one@example.com' }),
        makeUserRow({ id: otherUserId, email: 'two@example.com' }),
      ]);
  });

  afterAll(async () => {
    await database?.close();
  });

  const remember = () =>
    store.remember({
      objectKey,
      userId,
      purpose: 'base_image',
      contentType: 'image/png',
      expiresAt,
    });

  it('consumes an intent exactly once for its owner and purpose', async () => {
    expect(okValue(await remember())).toEqual({
      type: 'upload_intent_remembered',
    });

    expect(
      okValue(
        await store.consume({
          objectKey,
          userId: otherUserId,
          purpose: 'base_image',
          now: issuedAt,
        })
      )
    ).toEqual({ type: 'upload_intent_unowned' });
    expect(
      okValue(
        await store.consume({
          objectKey,
          userId,
          purpose: 'region_mask',
          now: issuedAt,
        })
      )
    ).toEqual({ type: 'upload_intent_unowned' });

    expect(
      okValue(
        await store.consume({
          objectKey,
          userId,
          purpose: 'base_image',
          now: issuedAt,
        })
      )
    ).toEqual({ type: 'upload_intent_consumed', contentType: 'image/png' });
    expect(
      okValue(
        await store.consume({
          objectKey,
          userId,
          purpose: 'base_image',
          now: issuedAt,
        })
      )
    ).toEqual({ type: 'upload_intent_unowned' });
  });

  it('refuses expired intents', async () => {
    await remember();
    expect(
      okValue(
        await store.consume({
          objectKey,
          userId,
          purpose: 'base_image',
          now: new Date('2026-11-02T12:31:00.000Z'),
        })
      )
    ).toEqual({ type: 'upload_intent_unowned' });
  });
});

describe('provider call log (drizzle)', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
    await database.truncate();
  });

  afterAll(async () => {
    await database?.close();
  });

  it('upserts by id so retried steps update one row', async () => {
    const log = createProviderCallLog({ db: database.db });
    const id = unwrapParseResult(toProviderCallId('call-1'));
    const base = {
      id,
      userId,
      designId: 'design-1',
      purpose: 'render' as const,
      provider: 'fal',
      endpoint: 'krea/v3/edit',
      subjectId: 'result-1',
      providerRequestId: undefined,
      status: 'submitted' as const,
      costUsdMicros: undefined,
      costSource: 'unavailable' as const,
      details: {},
      startedAt: issuedAt,
      completedAt: undefined,
    };
    await log.record(base);
    await log.record({
      ...base,
      providerRequestId: 'fal-req-1',
      status: 'succeeded',
      costUsdMicros: 170_000,
      costSource: 'price_table',
      completedAt: expiresAt,
    });

    const rows = await database.db.select().from(providerCall);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'call-1',
      providerRequestId: 'fal-req-1',
      status: 'succeeded',
      costUsdMicros: 170_000,
      costSource: 'price_table',
    });
  });
});
