import { sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  blockedOutstanding,
  handedOff,
  renderOutputCleanupBlocked,
} from '@/modules/rendering/testing';

describe('cleanup correlation through the production Drizzle compiler', () => {
  it.each([
    ['outstanding', blockedOutstanding],
    ['handed off', handedOff],
  ])(
    'preserves %s correlation directly and inside other SQL expressions',
    (_name, predicate) => {
      const builder = new QueryBuilder();
      const expressions = [
        predicate,
        sql`${predicate}`,
        sql`case when ${predicate} then 1 else 0 end`,
        sql`count(*) filter (where ${predicate})`,
      ];
      for (const expression of expressions) {
        const statement = builder
          .select({ state: expression })
          .from(renderOutputCleanupBlocked)
          .toSQL().sql;
        const correlation =
          /"([^"]+)"\."fingerprint" = "render_output_cleanup_blocked"\."fingerprint"/u.exec(
            statement
          );
        expect(correlation).not.toBeNull();
        expect(correlation?.[1]).not.toBe('render_output_cleanup_blocked');
        expect(statement).toContain(
          `from "render_output_cleanup_recovery" "${correlation?.[1]}"`
        );
        expect(statement).not.toContain('"fingerprint" = "fingerprint"');
      }
      const filtered = builder
        .select()
        .from(renderOutputCleanupBlocked)
        .where(predicate)
        .toSQL().sql;
      expect(filtered).toMatch(
        /"[^"]+"\."fingerprint" = "render_output_cleanup_blocked"\."fingerprint"/u
      );
    }
  );
});
