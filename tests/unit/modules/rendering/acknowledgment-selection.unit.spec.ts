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
    const baseQuery = new QueryBuilder()
      .select()
      .from(recovery)
      .where(base.where)
      .orderBy(...base.orderBy)
      .toSQL();
    const selected = acknowledgmentSelection(earliest, canonical.fingerprint);
    const query = new QueryBuilder()
      .select()
      .from(earliest)
      .where(selected.where)
      .orderBy(...selected.orderBy)
      .toSQL();

    expect(baseQuery.sql).toContain(
      'where ("render_output_cleanup_recovery"."fingerprint" = $1 and "render_output_cleanup_recovery"."outcome" = $2)'
    );
    expect(baseQuery.sql).toContain(
      'order by "render_output_cleanup_recovery"."createdAt" asc, "render_output_cleanup_recovery"."requestId" asc'
    );
    expect(baseQuery.params).toEqual(['fingerprint', 'cleanup_acknowledged']);
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
