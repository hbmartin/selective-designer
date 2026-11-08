import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Independent of parent lifetime. No credentials, output locators or object references. */
export const providerCallReceipt = pgTable(
  'provider_call_receipt',
  {
    id: text('id').primaryKey(),
    createdAt: timestamp('createdAt', { precision: 3, mode: 'date' })
      .notNull()
      .default(sql`(now() at time zone 'UTC')`),
    userId: text('userId'),
    designId: text('designId'),
    subjectId: text('subjectId'),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    endpoint: text('endpoint').notNull(),
    providerRequestId: text('providerRequestId'),
    status: text('status').notNull(),
    costUsdMicros: bigint('costUsdMicros', { mode: 'number' }),
    costSource: text('costSource').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull(),
    startedAt: timestamp('startedAt', { precision: 3, mode: 'date' }).notNull(),
    completedAt: timestamp('completedAt', { precision: 3, mode: 'date' }),
    deliveredAt: timestamp('deliveredAt', { precision: 3, mode: 'date' }),
    deliveryAttempts: integer('deliveryAttempts').notNull().default(0),
    lastErrorCode: text('lastErrorCode'),
  },
  (t) => [
    index('provider_call_receipt_pending_idx').on(
      t.deliveredAt,
      t.createdAt,
      t.id
    ),
    index('provider_call_receipt_pending_id_idx')
      .on(t.id)
      .where(sql`${t.deliveredAt} is null`),
    uniqueIndex('provider_call_receipt_request_idx').on(
      t.provider,
      t.endpoint,
      t.providerRequestId
    ),
  ]
);
