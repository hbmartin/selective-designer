import { sql, type SQLWrapper } from 'drizzle-orm';

/** Preserve metadata and null checkpoints while retiring provider credentials atomically. */
export const retiredOutputCheckpoint = (column: SQLWrapper) =>
  sql`case when ${column} is null then null else jsonb_set(${column}, '{source}', '{"kind":"retired"}'::jsonb) end`;
