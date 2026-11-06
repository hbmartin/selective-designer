import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { design, image } from '@/modules/design/infrastructure/drizzle/schema';
import {
  createdAtColumn,
  idColumn,
  updatedAtColumn,
} from '@/modules/kernel/infrastructure/db/schema/common';
import type { EditSet } from '@/modules/rendering/domain/edit-set';
import type { RenderRecipe } from '@/modules/rendering/domain/recipe';
import type { ModelSettings } from '@/modules/rendering/domain/render';
import type { RenderOutputCheckpoint } from '@/modules/rendering/domain/render-output';

/** Autosaved unfinished edits, one per render source. */
export const renderDraft = pgTable(
  'render_draft',
  {
    id: idColumn(),
    updatedAt: updatedAtColumn(),
    designId: text('designId')
      .notNull()
      .references(() => design.id, { onDelete: 'cascade' }),
    renderSourceImageId: text('renderSourceImageId')
      .notNull()
      .references(() => image.id, { onDelete: 'cascade' }),
    editSet: jsonb('editSet').$type<EditSet>().notNull(),
    revision: integer('revision').notNull(),
  },
  (table) => [
    uniqueIndex('render_draft_source_key').on(table.renderSourceImageId),
  ]
);

export const render = pgTable(
  'render',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    designId: text('designId')
      .notNull()
      .references(() => design.id, { onDelete: 'cascade' }),
    renderSourceImageId: text('renderSourceImageId')
      .notNull()
      .references(() => image.id, { onDelete: 'cascade' }),
    batchId: text('batchId'),
    batchOptionItemId: text('batchOptionItemId'),
    /** Immutable snapshot captured at submit. */
    recipe: jsonb('recipe').$type<RenderRecipe>().notNull(),
    preferredResultId: text('preferredResultId'),
  },
  (table) => [index('render_design_idx').on(table.designId, table.createdAt)]
);

export const renderResult = pgTable(
  'render_result',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    renderId: text('renderId')
      .notNull()
      .references(() => render.id, { onDelete: 'cascade' }),
    modelId: text('modelId').notNull(),
    status: text('status').notNull(),
    skipReason: text('skipReason'),
    attempt: integer('attempt').default(1).notNull(),
    attemptStartedAt: timestamp('attemptStartedAt', {
      precision: 3,
      mode: 'date',
    })
      .default(sql`(now() at time zone 'UTC')`)
      .notNull(),
    providerRequestId: text('providerRequestId'),
    workflowRunId: text('workflowRunId'),
    accountingIdentity: jsonb('accountingIdentity').$type<{
      invocationId: string;
      providerRequestId?: string;
    }>(),
    outputCheckpoint: jsonb('outputCheckpoint').$type<RenderOutputCheckpoint>(),
    modelVersion: text('modelVersion'),
    settings: jsonb('settings').$type<ModelSettings>().default({}).notNull(),
    prompt: text('prompt'),
    outputImageId: text('outputImageId'),
    framingChanged: boolean('framingChanged').default(false).notNull(),
    errorMessage: text('errorMessage'),
    costUsdMicros: bigint('costUsdMicros', { mode: 'number' }),
    costSource: text('costSource'),
    /** Set when the user names this result as a scheme. */
    schemeName: text('schemeName'),
    submittedAt: timestamp('submittedAt', { precision: 3, mode: 'date' }),
    completedAt: timestamp('completedAt', { precision: 3, mode: 'date' }),
  },
  (table) => [
    index('render_result_render_idx').on(table.renderId),
    index('render_result_output_key_idx').on(
      sql`(${table.outputCheckpoint}->>'objectKey')`
    ),
  ]
);

export type RenderRow = typeof render.$inferSelect;
export type RenderResultRow = typeof renderResult.$inferSelect;
export type RenderDraftRow = typeof renderDraft.$inferSelect;
