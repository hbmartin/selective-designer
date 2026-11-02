import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, updatedAtColumn } from './common';

/**
 * One paid call to an external model provider (render, segmentation,
 * background removal). Cost is logged only; nothing reads it to block work.
 * `costUsdMicros` is null when the cost is unknown — never recorded as zero.
 */
export const providerCall = pgTable(
  'provider_call',
  {
    id: text('id').primaryKey(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    userId: text('userId'),
    designId: text('designId'),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    endpoint: text('endpoint').notNull(),
    subjectId: text('subjectId'),
    providerRequestId: text('providerRequestId'),
    status: text('status').notNull(),
    costUsdMicros: bigint('costUsdMicros', { mode: 'number' }),
    costSource: text('costSource').notNull(),
    details: jsonb('details')
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    startedAt: timestamp('startedAt', { precision: 3, mode: 'date' }).notNull(),
    completedAt: timestamp('completedAt', { precision: 3, mode: 'date' }),
  },
  (table) => [
    index('provider_call_design_idx').on(table.designId),
    index('provider_call_subject_idx').on(table.subjectId),
    index('provider_call_started_at_idx').on(table.startedAt),
  ]
);
