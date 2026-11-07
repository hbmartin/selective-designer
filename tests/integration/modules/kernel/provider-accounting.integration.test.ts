import { createRecoveryTestDatabase } from '@tests/server/recovery-database';
import { makeProviderReceipt } from '@tests/support/provider-receipt';
import { okValue } from '@tests/support/result';
import { eq, sql } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createProviderAccounting,
  createProviderReceiptStore,
  getDatabaseErrorCode,
  pendingProviderReceipts,
  providerAccountingSummary,
} from '@/modules/kernel/backend';
import { createProviderCallLog } from '@/modules/kernel/infrastructure/db/provider-call-log-drizzle';
import {
  providerCall,
  providerCallReceipt,
} from '@/modules/kernel/infrastructure/db/schema';

const now = new Date('2026-11-06T01:00:00Z');
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
describe('durable provider accounting', () => {
  let database: Awaited<ReturnType<typeof createRecoveryTestDatabase>>;
  beforeAll(async () => {
    database = await createRecoveryTestDatabase();
  });
  beforeEach(async () => {
    await database.truncate();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await database?.close();
  });
  const gateway = () =>
    createProviderAccounting({
      db: database.db,
      clock: { now: () => now },
      logger,
    });

  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'keeps receipts pending during sink failure and delivers after recovery',
    async () => {
      await database.db.execute(
        sql`alter table provider_call add constraint accounting_test_down check (status <> 'succeeded')`
      );
      const receipt = makeProviderReceipt();
      try {
        expect(okValue(await gateway().capture(receipt))).toEqual({
          type: 'receipt_captured',
          receiptId: receipt.id,
        });
        expect(await database.db.select().from(providerCall)).toHaveLength(0);
        expect(
          okValue(await providerAccountingSummary(database.db)).pending
        ).toBe(1);
        expect(
          (await database.db.select().from(providerCallReceipt))[0]
        ).toMatchObject({ deliveredAt: null, costUsdMicros: 123 });
      } finally {
        await database.db.execute(
          sql`alter table provider_call drop constraint accounting_test_down`
        );
      }
      expect(okValue(await gateway().deliver(receipt.id)).type).toBe(
        'receipt_delivered'
      );
      expect(okValue(await gateway().deliver(receipt.id)).type).toBe(
        'receipt_delivered'
      );
      expect(await database.db.select().from(providerCall)).toHaveLength(1);
      expect(
        okValue(await providerAccountingSummary(database.db)).pending
      ).toBe(0);
    }
  );
  it('deduplicates replay while retaining distinct requests for the same attempt', async () => {
    const first = makeProviderReceipt();
    const second = makeProviderReceipt({
      providerRequestId: 'native-2',
      costUsdMicros: 456,
    });
    // The embedded socket server shares one transaction session; native coverage below arbitrates concurrent connections.
    okValue(await gateway().capture(first));
    okValue(await gateway().capture(first));
    okValue(await gateway().capture(second));
    okValue(await gateway().deliver(first.id));
    okValue(await gateway().deliver(second.id));
    expect(await database.db.select().from(providerCallReceipt)).toHaveLength(
      2
    );
    expect(await database.db.select().from(providerCall)).toHaveLength(2);
    await gateway().capture({
      ...first,
      costUsdMicros: 999,
      completedAt: '2026-11-06T00:05:00.000Z',
    });
    expect(
      (
        await database.db
          .select()
          .from(providerCall)
          .where(eq(providerCall.id, first.id))
      )[0]
    ).toMatchObject({
      costUsdMicros: 123,
      completedAt: new Date(first.completedAt!),
    });
  });
  it('preserves a successful sink row against failure or submitted replay', async () => {
    const receipt = makeProviderReceipt();
    await gateway().capture(receipt);
    okValue(await gateway().deliver(receipt.id));
    const sink = createProviderCallLog({ db: database.db });
    for (const status of ['failed', 'submitted'] as const)
      okValue(
        await sink.record({
          ...receipt,
          status,
          costUsdMicros: undefined,
          costSource: 'unavailable',
          startedAt: new Date(receipt.startedAt),
          completedAt: undefined,
        })
      );
    expect((await database.db.select().from(providerCall))[0]).toMatchObject({
      status: 'succeeded',
      costUsdMicros: 123,
    });
  });
  it('allows submitted accounting to advance without discarding known cost', async () => {
    const receipt = makeProviderReceipt();
    const sink = createProviderCallLog({ db: database.db });
    const call = {
      ...receipt,
      startedAt: new Date(receipt.startedAt),
      completedAt: undefined,
    };
    okValue(await sink.record({ ...call, status: 'submitted' }));
    okValue(
      await sink.record({
        ...call,
        status: 'failed',
        costUsdMicros: undefined,
        costSource: 'unavailable',
      })
    );
    expect((await database.db.select().from(providerCall))[0]).toMatchObject({
      status: 'failed',
      costUsdMicros: 123,
      costSource: 'reported',
    });
  });
  it('rejects malformed timestamps and URL identities without persisting them', async () => {
    for (const receipt of [
      makeProviderReceipt({ startedAt: 'invalid' }),
      makeProviderReceipt({
        providerRequestId: 'https://provider.test/private?token=secret',
      }),
    ])
      expect((await gateway().capture(receipt)).isError()).toBe(true);
    expect(await database.db.select().from(providerCallReceipt)).toHaveLength(
      0
    );
  });
  it('captures independently of parent rows and pages past a failing receipt', async () => {
    const store = createProviderReceiptStore({ db: database.db });
    const a = makeProviderReceipt({
      providerRequestId: 'a',
      userId: undefined,
      designId: 'deleted-design',
    });
    const b = makeProviderReceipt({ providerRequestId: 'b' });
    okValue(await store.capture(a));
    okValue(await store.capture(b));
    const page = okValue(
      await pendingProviderReceipts(database.db, {
        before: new Date('2100-01-01Z'),
        limit: 1,
      })
    );
    const next = okValue(
      await pendingProviderReceipts(database.db, {
        before: new Date('2100-01-01Z'),
        after: page.ids[0],
        limit: 1,
      })
    );
    expect(page.ids).toHaveLength(1);
    expect(next.ids).toHaveLength(1);
    expect(page.ids).not.toEqual(next.ids);
  });
  it('includes newly captured receipts at a UTC cutoff', async () => {
    okValue(
      await createProviderReceiptStore({ db: database.db }).capture(
        makeProviderReceipt()
      )
    );
    expect(
      okValue(
        await pendingProviderReceipts(database.db, {
          before: new Date(Date.now() + 60_000),
          limit: 100,
        })
      ).ids
    ).toHaveLength(1);
  });
  it.each(['timestamp', 'identity', 'mismatch'] as const)(
    'preserves permanent %s capture errors without retrying',
    async (kind) => {
      const receipt = makeProviderReceipt();
      if (kind === 'mismatch') okValue(await gateway().capture(receipt));
      const result = await gateway().capture({
        ...receipt,
        ...(kind === 'timestamp' ? { startedAt: 'invalid' } : {}),
        ...(kind === 'identity'
          ? { providerRequestId: 'https://private.example/request' }
          : {}),
        ...(kind === 'mismatch' ? { subjectId: 'other-subject' } : {}),
      });
      expect(result.isError()).toBe(true);
      if (result.isError())
        expect(result.getError()).toMatchObject({
          retryable: false,
          code:
            kind === 'timestamp'
              ? 'PROVIDER_RECEIPT_INVALID_TIMESTAMP'
              : kind === 'identity'
                ? 'PROVIDER_RECEIPT_INVALID_IDENTITY'
                : 'PROVIDER_RECEIPT_IDENTITY_MISMATCH',
        });
    }
  );
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'arbitrates simultaneous delivery on native connections',
    async () => {
      const first = makeProviderReceipt();
      const second = makeProviderReceipt({
        providerRequestId: 'concurrent-second',
      });
      const results = await Promise.all([
        gateway().capture(first),
        gateway().capture(first),
        gateway().capture(second),
      ]);
      results.forEach(okValue);
      okValue(await gateway().deliver(first.id));
      okValue(await gateway().deliver(second.id));
      expect(await database.db.select().from(providerCallReceipt)).toHaveLength(
        2
      );
      expect(await database.db.select().from(providerCall)).toHaveLength(2);
    }
  );
  it('captures without writing the cost sink before the worker executes', async () => {
    const receipt = makeProviderReceipt();
    okValue(await gateway().capture(receipt));
    expect(await database.db.select().from(providerCall)).toHaveLength(0);
    expect(
      (await database.db.select().from(providerCallReceipt))[0]
    ).toMatchObject({ deliveredAt: null, deliveryAttempts: 0 });
  });
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'bounds cost-log lock waits without acknowledging the receipt',
    async () => {
      const receipt = makeProviderReceipt();
      okValue(
        await createProviderReceiptStore({ db: database.db }).capture(receipt)
      );
      okValue(
        await createProviderCallLog({ db: database.db }).record({
          ...receipt,
          status: 'submitted',
          startedAt: new Date(receipt.startedAt),
          completedAt: undefined,
        })
      );
      let release: () => void = () => {};
      let acquired: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const blocker = database.db.$runInTransaction!(async (tx) => {
        await tx
          .select()
          .from(providerCall)
          .where(eq(providerCall.id, receipt.id))
          .for('update');
        acquired();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      await ready;
      const safetyRelease = setTimeout(() => release(), 4_000);
      try {
        const failed = await gateway().deliver(receipt.id);
        expect(failed.isError()).toBe(true);
        if (failed.isError())
          expect(getDatabaseErrorCode(failed.getError())).toBe('55P03');
        expect(
          (await database.db.select().from(providerCallReceipt))[0]
            ?.lastErrorCode
        ).toBe('55P03');
        expect(
          (await database.db.select().from(providerCallReceipt))[0]?.deliveredAt
        ).toBeNull();
      } finally {
        clearTimeout(safetyRelease);
        release();
        await blocker;
      }
    }
  );
  it('promotes submitted receipts, redelivers terminal data, and never regresses success', async () => {
    const success = makeProviderReceipt();
    const submitted = {
      ...success,
      status: 'submitted' as const,
      costUsdMicros: undefined,
      costSource: 'unavailable' as const,
      completedAt: undefined,
    };
    okValue(await gateway().capture(submitted));
    okValue(await gateway().deliver(success.id));
    const failed = {
      ...submitted,
      status: 'failed' as const,
      completedAt: success.completedAt,
    };
    okValue(await gateway().capture(failed));
    expect(
      (await database.db.select().from(providerCallReceipt))[0]
    ).toMatchObject({ status: 'failed', deliveredAt: null });
    okValue(await gateway().deliver(success.id));
    okValue(await gateway().capture(success));
    okValue(await gateway().deliver(success.id));
    okValue(await gateway().capture(submitted));
    expect((await database.db.select().from(providerCall))[0]).toMatchObject({
      status: 'succeeded',
      costUsdMicros: 123,
    });
  });
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'does not reconcile a rejected promotion from the older submitted identity',
    async () => {
      const success = makeProviderReceipt();
      okValue(
        await gateway().capture({
          ...success,
          status: 'submitted',
          costUsdMicros: undefined,
          costSource: 'unavailable',
          completedAt: undefined,
        })
      );
      await database.db.execute(
        sql`alter table provider_call_receipt add constraint receipt_promotion_test_down check (status <> 'succeeded')`
      );
      try {
        expect((await gateway().capture(success)).isError()).toBe(true);
        expect(
          (await database.db.select().from(providerCallReceipt))[0]
        ).toMatchObject({ status: 'submitted', costUsdMicros: null });
      } finally {
        await database.db.execute(
          sql`alter table provider_call_receipt drop constraint receipt_promotion_test_down`
        );
      }
      okValue(await gateway().capture(success));
    }
  );
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'reconciles a committed promotion after its reply was lost',
    async () => {
      const receipt = makeProviderReceipt();
      okValue(
        await gateway().capture({
          ...receipt,
          status: 'submitted',
          costUsdMicros: undefined,
          costSource: 'unavailable',
          completedAt: undefined,
        })
      );
      const query = database.db.$client.query.bind(database.db.$client);
      let lost = false;
      const spy = vi
        .spyOn(database.db.$client, 'query')
        .mockImplementation(async (text, values) => {
          const result = await query(text, values);
          const statement =
            typeof text === 'string' ? text : (text as { text: string }).text;
          if (!lost && statement.startsWith('update "provider_call_receipt"')) {
            lost = true;
            throw Object.assign(new Error('lost update reply'), {
              code: 'EPIPE',
            });
          }
          return result;
        });
      try {
        expect(okValue(await gateway().capture(receipt)).type).toBe(
          'receipt_captured'
        );
        expect(lost).toBe(true);
      } finally {
        spy.mockRestore();
      }
      expect(
        (await database.db.select().from(providerCallReceipt))[0]
      ).toMatchObject({ status: 'succeeded', costUsdMicros: 123 });
    }
  );
});
