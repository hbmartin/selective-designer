import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { design } from '@/modules/design/infrastructure/drizzle/schema';
import {
  createdAtColumn,
  idColumn,
  updatedAtColumn,
} from '@/modules/kernel/infrastructure/db/schema/common';

export const item = pgTable(
  'item',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    designId: text('designId')
      .notNull()
      .references(() => design.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    vendor: text('vendor'),
    productUrl: text('productUrl'),
    currentVersionId: text('currentVersionId').notNull(),
    removedAt: timestamp('removedAt', { precision: 3, mode: 'date' }),
  },
  (table) => [index('item_design_idx').on(table.designId, table.removedAt)]
);

export const itemVersion = pgTable(
  'item_version',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    itemId: text('itemId')
      .notNull()
      .references(() => item.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    photoKey: text('photoKey').notNull(),
    photoContentType: text('photoContentType').notNull(),
    photoWidth: integer('photoWidth').notNull(),
    photoHeight: integer('photoHeight').notNull(),
    cutoutKey: text('cutoutKey'),
    maskKey: text('maskKey'),
    cutoutStatus: text('cutoutStatus').notNull(),
    cutoutAttemptId: text('cutoutAttemptId'),
    cutoutAttemptStartedAt: timestamp('cutoutAttemptStartedAt', {
      precision: 3,
      mode: 'date',
    }),
  },
  (table) => [index('item_version_item_idx').on(table.itemId)]
);

export type ItemRow = typeof item.$inferSelect;
export type ItemVersionRow = typeof itemVersion.$inferSelect;
