import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { createdAtColumn } from './common';

/**
 * A presigned upload issued to one user for one purpose. Registering the
 * uploaded object consumes the intent exactly once, so a caller can only
 * attach objects it was actually issued. Durable across serverless instances.
 */
export const uploadIntent = pgTable(
  'upload_intent',
  {
    objectKey: text('objectKey').primaryKey(),
    // Kernel cannot reference the auth-owned user table; intents expire anyway.
    userId: text('userId').notNull(),
    purpose: text('purpose').notNull(),
    contentType: text('contentType').notNull(),
    createdAt: createdAtColumn(),
    expiresAt: timestamp('expiresAt', { precision: 3, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumedAt', { precision: 3, mode: 'date' }),
  },
  (table) => [
    index('upload_intent_user_idx').on(table.userId),
    index('upload_intent_expires_at_idx').on(table.expiresAt),
  ]
);
