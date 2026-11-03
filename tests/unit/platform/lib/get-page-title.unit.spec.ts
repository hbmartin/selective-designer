import { describe, expect, it } from 'vitest';

import { getPageTitle } from '@/platform/lib/get-page-title';

describe('getPageTitle', () => {
  it('omits the prefix separator when no title prefix is provided', () => {
    expect(getPageTitle('Home')).toBe('Home | Selective Designer');
    expect(getPageTitle()).toBe('Selective Designer');
  });

  it('adds a separator when a title prefix is provided', () => {
    expect(getPageTitle('Home', '[Demo]')).toBe(
      '[Demo] Home | Selective Designer'
    );
    expect(getPageTitle(undefined, '[Demo]')).toBe('[Demo] Selective Designer');
  });
});
