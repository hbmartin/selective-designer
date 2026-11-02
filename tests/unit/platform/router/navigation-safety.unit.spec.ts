import { describe, expect, it } from 'vitest';

import {
  isProtectedNavigationPath,
  normalizeNavigationPathname,
  SIDE_EFFECT_ROUTE_PATHNAMES,
} from '@/platform/router';

describe('navigation safety', () => {
  it('centralizes side-effect routes that cannot be declarative links', () => {
    expect(SIDE_EFFECT_ROUTE_PATHNAMES).toEqual(['/logout']);
  });

  it('normalizes local navigation pathnames', () => {
    expect(normalizeNavigationPathname('/logout')).toBe('/logout');
    expect(normalizeNavigationPathname('/logout/')).toBe('/logout');
    expect(normalizeNavigationPathname('/logout//')).toBe('/logout');
    expect(normalizeNavigationPathname('/app/../logout')).toBe('/logout');
    expect(normalizeNavigationPathname('/logout/?next=/manager#top')).toBe(
      '/logout'
    );
  });

  it('does not normalize external-looking targets as local pathnames', () => {
    expect(
      normalizeNavigationPathname('https://app.example/logout')
    ).toBeNull();
    expect(normalizeNavigationPathname('//app.example/logout')).toBeNull();
    expect(normalizeNavigationPathname('mailto:user@example.com')).toBeNull();
    expect(normalizeNavigationPathname('logout')).toBeNull();
    expect(normalizeNavigationPathname('')).toBeNull();
  });

  it('protects logout route variants', () => {
    expect(isProtectedNavigationPath('/logout')).toBe(true);
    expect(isProtectedNavigationPath('/logout/')).toBe(true);
    expect(isProtectedNavigationPath('/app/../logout')).toBe(true);
  });

  it('does not protect ordinary declarative routes or external-looking values', () => {
    for (const pathname of [
      '/login',
      '/manager',
      '/app/designs',
      '/api/upload',
      '/api/telemetry/logs',
      '/logout/confirm',
      'https://app.example/logout',
      '//app.example/logout',
    ]) {
      expect(isProtectedNavigationPath(pathname)).toBe(false);
    }
  });
});
