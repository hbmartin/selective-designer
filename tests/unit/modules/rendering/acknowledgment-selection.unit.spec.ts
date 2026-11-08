import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  acknowledgmentSelection,
  renderOutputCleanupRecovery as recovery,
} from '@/modules/rendering/testing';

describe('canonical acknowledgment selection', () => {
  it('accepts base and aliased columns without erasing outcome or fingerprint types', () => {
    const canonical = alias(recovery, 'canonical');
    const earliest = alias(recovery, 'earliest');
    const base = acknowledgmentSelection(recovery, 'fingerprint');
    const selected = acknowledgmentSelection(earliest, canonical.fingerprint);
    const query = new QueryBuilder()
      .select()
      .from(earliest)
      .where(selected.where)
      .orderBy(...selected.orderBy)
      .toSQL();

    expect(base.where).toBeDefined();
    expect(query.sql).toContain(
      '"earliest"."fingerprint" = "canonical"."fingerprint"'
    );
    expect(query.sql).toContain(
      'order by "earliest"."createdAt" asc, "earliest"."requestId" asc'
    );
    expect(query.params).toEqual(['cleanup_acknowledged']);

    type SelectionInput = Parameters<typeof acknowledgmentSelection>;
    expectTypeOf<SelectionInput[0]['outcome']['_']['data']>().toEqualTypeOf<
      typeof recovery.$inferSelect.outcome
    >();
    expectTypeOf<'cleanup_acknowleged'>().not.toExtend<
      SelectionInput[0]['outcome']['_']['data']
    >();
    expectTypeOf<typeof canonical.createdAt>().not.toExtend<
      SelectionInput[1]
    >();
  });
});
