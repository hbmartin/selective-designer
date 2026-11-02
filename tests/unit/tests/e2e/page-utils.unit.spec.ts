import { globToRegExp } from '@tests/e2e/utils/page';
import { describe, expect, it } from 'vitest';

describe('e2e page URL glob helpers', () => {
  it('collapses consecutive wildcards before building the regular expression', () => {
    const pattern = globToRegExp('/app/**/designs');

    expect(pattern.source).not.toContain('.*.*');
    expect('/app/manager/featured/designs').toMatch(pattern);
    expect('/manager/featured/designs').not.toMatch(pattern);
  });
});
