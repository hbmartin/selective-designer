import { Result } from '@bloodyowl/boxed';
import { eq } from 'drizzle-orm';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';
import { renderResultTable as renderResult } from '@/modules/rendering/testing';

export async function updateRenderResultFixture(
  db: DbLike,
  input: {
    resultId: string;
    changes: Partial<typeof renderResult.$inferInsert>;
  }
) {
  await db
    .update(renderResult)
    .set(input.changes)
    .where(eq(renderResult.id, input.resultId));
  return Result.Ok({ type: 'fixture_updated' });
}
