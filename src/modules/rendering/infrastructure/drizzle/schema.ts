import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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

import type { RenderAccountingIdentity } from '../../application/ports/ports';

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
    accountingIdentity:
      jsonb('accountingIdentity').$type<RenderAccountingIdentity>(),
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

/** Independent cleanup responsibility; intentionally survives result/design deletion. */
export const renderOutputCleanup = pgTable(
  'render_output_cleanup',
  {
    objectKey: text('objectKey').primaryKey(),
    resultId: text('resultId').notNull(),
    attempt: integer('attempt').notNull(),
    createdAt: timestamp('createdAt', { precision: 3, mode: 'date' }).notNull(),
    nextAttemptAt: timestamp('nextAttemptAt', {
      precision: 3,
      mode: 'date',
    }).notNull(),
    leaseUntil: timestamp('leaseUntil', { precision: 3, mode: 'date' }),
    claimToken: text('claimToken'),
    attempts: integer('attempts').notNull().default(0),
    lastErrorCode: text('lastErrorCode'),
    outcome: text('outcome'),
    completedAt: timestamp('completedAt', { precision: 3, mode: 'date' }),
  },
  (t) => [
    index('render_output_cleanup_pending_idx')
      .on(t.nextAttemptAt, t.objectKey)
      .where(sql`${t.completedAt} is null`),
  ]
);

/** Retained evidence; only validated, eligible cleanup jobs can authorize deletion. */
export const renderOutputCleanupBlocked = pgTable(
  'render_output_cleanup_blocked',
  {
    fingerprint: text('fingerprint').primaryKey(),
    safeObjectKey: text('safeObjectKey'),
    resultId: text('resultId'),
    attempt: integer('attempt'),
    reasonCode: text('reasonCode').notNull(),
    createdAt: timestamp('createdAt', { precision: 3, mode: 'date' }).notNull(),
  },
  (table) => [
    index('render_output_cleanup_blocked_page_idx').on(
      table.createdAt.desc(),
      table.fingerprint
    ),
  ]
);

/** Explicit operator recovery audit; no parent lifetime or storage-reference semantics. */
export const renderOutputCleanupRecovery = pgTable(
  'render_output_cleanup_recovery',
  {
    requestId: text('requestId').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    resultId: text('resultId'),
    attempt: integer('attempt'),
    objectKey: text('objectKey'),
    reasonCode: text('reasonCode'),
    outcome: text('outcome')
      .$type<
        | 'cleanup_acknowledged'
        | 'cleanup_requeued'
        | 'cleanup_already_pending'
        | 'cleanup_already_completed'
      >()
      .notNull(),
    previousOutcome: text('previousOutcome'),
    previousCompletedAt: timestamp('previousCompletedAt', {
      precision: 3,
      mode: 'date',
    }),
    createdAt: timestamp('createdAt', { precision: 3, mode: 'date' }).notNull(),
  },
  (table) => [
    check(
      'render_output_cleanup_recovery_shape',
      sql`(${table.outcome} = 'cleanup_acknowledged' and ${table.reasonCode} = 'locator_unavailable_retained' and ${table.resultId} is null and ${table.attempt} is null and ${table.objectKey} is null) or (${table.outcome} in ('cleanup_requeued', 'cleanup_already_pending', 'cleanup_already_completed') and ${table.resultId} is not null and ${table.attempt} is not null and ${table.objectKey} is not null and ${table.reasonCode} is null)`
    ),
    index('render_output_cleanup_recovery_fingerprint_idx').on(
      table.fingerprint,
      table.createdAt
    ),
  ]
);
