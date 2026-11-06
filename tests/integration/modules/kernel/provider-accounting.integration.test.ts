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
  const gateway = (
    schedule?: (
      id: ReturnType<typeof makeProviderReceipt>['id']
    ) => Promise<void>
  ) =>
    createProviderAccounting({
      db: database.db,
      clock: { now: () => now },
      logger,
      schedule,
    });

  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'keeps receipts pending during sink failure and delivers after recovery',
    async () => {
      await database.db.execute(
        sql`alter table provider_call add constraint accounting_test_down check (status <> 'succeeded')`
      );
      const receipt = makeProviderReceipt();
      const schedule = vi.fn(async () => {});
      try {
        expect(okValue(await gateway(schedule).capture(receipt))).toEqual({
          type: 'receipt_captured',
          receiptId: receipt.id,
        });
        expect(await database.db.select().from(providerCall)).toHaveLength(0);
        expect(
          okValue(await providerAccountingSummary(database.db)).pending
        ).toBe(1);
        expect(schedule).toHaveBeenCalledWith(receipt.id);
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
  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'retains pending work if prompt dispatch fails',
    async () => {
      await database.db.execute(
        sql`alter table provider_call add constraint accounting_test_down check (status <> 'succeeded')`
      );
      try {
        okValue(
          await gateway(async () => {
            throw new Error('queue unavailable');
          }).capture(makeProviderReceipt())
        );
        expect(
          okValue(await providerAccountingSummary(database.db)).pending
        ).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'provider_accounting.dispatch_failed',
          })
        );
      } finally {
        await database.db.execute(
          sql`alter table provider_call drop constraint accounting_test_down`
        );
      }
    }
  );
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
});
