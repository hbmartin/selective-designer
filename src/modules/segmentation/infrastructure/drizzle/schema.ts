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

import type {
  DetectionPhase,
  DetectionProgress,
} from '../../application/ports/ports';

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
  (table) => [
    index('region_image_idx').on(table.imageId, table.source),
    index('region_mask_key_idx').on(table.maskKey),
  ]
);

export type RegionRow = typeof region.$inferSelect;

/** Durable detection state, retained until its image is deleted. */
export const activeDetection = pgTable('active_detection', {
  imageId: text('imageId')
    .primaryKey()
    .references(() => image.id, { onDelete: 'cascade' }),
  // Null identifies leases acquired before run IDs were introduced.
  runId: text('runId'),
  imageWriteId: text('imageWriteId').unique(),
  completedAt: timestamp('completedAt', { precision: 3, mode: 'date' }),
  phase: text('phase').$type<DetectionPhase>(),
  workerId: text('workerId'),
  failed: boolean('failed').default(false).notNull(),
  progress: jsonb('progress').$type<DetectionProgress>(),
  expiresAt: timestamp('expiresAt', { precision: 3, mode: 'date' }).notNull(),
});
