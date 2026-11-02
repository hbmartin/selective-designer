import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { user } from '@/modules/auth/infrastructure/drizzle/schema';
import {
  createdAtColumn,
  idColumn,
  updatedAtColumn,
} from '@/modules/kernel/infrastructure/db/schema/common';

export const design = pgTable(
  'design',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    ownerId: text('ownerId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The design's single base image; an `image` row of kind `base`. */
    baseImageId: text('baseImageId').notNull(),
    copiedFromDesignId: text('copiedFromDesignId'),
    archivedAt: timestamp('archivedAt', { precision: 3, mode: 'date' }),
  },
  (table) => [
    index('design_owner_updated_idx').on(
      table.ownerId,
      table.archivedAt,
      table.updatedAt
    ),
  ]
);

export const image = pgTable(
  'image',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    designId: text('designId')
      .notNull()
      .references(() => design.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    originalKey: text('originalKey').notNull(),
    originalContentType: text('originalContentType').notNull(),
    originalWidth: integer('originalWidth').notNull(),
    originalHeight: integer('originalHeight').notNull(),
    workingKey: text('workingKey').notNull(),
    workingWidth: integer('workingWidth').notNull(),
    workingHeight: integer('workingHeight').notNull(),
  },
  (table) => [index('image_design_idx').on(table.designId)]
);

export type DesignRow = typeof design.$inferSelect;
export type ImageRow = typeof image.$inferSelect;
