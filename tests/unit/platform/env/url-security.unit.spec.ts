import { describe, expect, it } from 'vitest';

import {
  isLocalhostUrl,
  isSecureUrlForProduction,
} from '@/platform/env/url-security';

describe('platform url-security', () => {
  it('detects loopback hosts', () => {
    expect(isLocalhostUrl('http://localhost:3000')).toBe(true);
    expect(isLocalhostUrl('http://127.0.0.1:9000/default')).toBe(true);
    expect(isLocalhostUrl('http://[::1]:9000')).toBe(true);
    expect(isLocalhostUrl('https://example.com')).toBe(false);
    expect(isLocalhostUrl('not-a-url')).toBe(false);
  });

  it('requires HTTPS only for production remote hosts', () => {
    expect(isSecureUrlForProduction('http://example.com', true)).toBe(false);
    expect(isSecureUrlForProduction('https://example.com', true)).toBe(true);
    expect(isSecureUrlForProduction('http://localhost:3000', true)).toBe(true);
    expect(isSecureUrlForProduction('http://example.com', false)).toBe(true);
  });
});
