import {
  boolean,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { design, image } from '@/modules/design/infrastructure/drizzle/schema';
import {
  createdAtColumn,
  idColumn,
} from '@/modules/kernel/infrastructure/db/schema/common';

import type { DetectionProgress } from '../../application/ports/ports';

export const region = pgTable(
  'region',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    designId: text('designId')
      .notNull()
      .references(() => design.id, { onDelete: 'cascade' }),
    imageId: text('imageId')
      .notNull()
      .references(() => image.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    label: text('label').notNull(),
    maskKey: text('maskKey').notNull(),
    box: jsonb('box')
      .$type<{ x: number; y: number; width: number; height: number }>()
      .notNull(),
    score: real('score'),
    isSuggestion: boolean('isSuggestion').default(false).notNull(),
    carriedFromRegionId: text('carriedFromRegionId'),
  },
  (table) => [index('region_image_idx').on(table.imageId, table.source)]
);

export type RegionRow = typeof region.$inferSelect;

/** In-progress or retryable automatic detection for one image. */
export const activeDetection = pgTable('active_detection', {
  imageId: text('imageId')
    .primaryKey()
    .references(() => image.id, { onDelete: 'cascade' }),
  // Null identifies leases acquired before run IDs were introduced.
  runId: text('runId'),
  failed: boolean('failed').default(false).notNull(),
  progress: jsonb('progress').$type<DetectionProgress>(),
  expiresAt: timestamp('expiresAt', { precision: 3, mode: 'date' }).notNull(),
});
