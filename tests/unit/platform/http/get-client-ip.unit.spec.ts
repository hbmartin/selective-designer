import { describe, expect, it } from 'vitest';

import { getClientIp } from '@/platform/http/get-client-ip';

const requestWith = (headers: Record<string, string>) =>
  new Request('http://localhost/api/telemetry/logs', { headers });

describe('getClientIp', () => {
  it('defaults to depth 1: the rightmost X-Forwarded-For entry, ignoring spoofed leftmost entries', () => {
    const ip = getClientIp(
      requestWith({ 'X-Forwarded-For': '1.2.3.4, 203.0.113.7' })
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('ignores additional attacker-supplied leftmost entries at depth 1', () => {
    const ip = getClientIp(
      requestWith({ 'X-Forwarded-For': '6.6.6.6, 1.2.3.4, 203.0.113.7' })
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('skips one more trusted hop at depth 2', () => {
    const ip = getClientIp(
      requestWith({ 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' }),
      { trustedProxyDepth: 2 }
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('fails closed when the configured trusted hop is missing', () => {
    const ip = getClientIp(
      requestWith({ 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' }),
      { trustedProxyDepth: 5 }
    );
    expect(ip).toBeUndefined();
  });

  it('fails closed for a single entry when depth requires more trusted hops', () => {
    expect(
      getClientIp(requestWith({ 'X-Forwarded-For': '203.0.113.7' }), {
        trustedProxyDepth: 3,
      })
    ).toBeUndefined();
  });

  it('fails closed when trustedProxyDepth is zero', () => {
    expect(
      getClientIp(requestWith({ 'X-Forwarded-For': '203.0.113.7' }), {
        trustedProxyDepth: 0,
      })
    ).toBeUndefined();
  });

  it('fails closed when trustedProxyDepth is not a safe integer', () => {
    expect(
      getClientIp(requestWith({ 'X-Forwarded-For': '203.0.113.7' }), {
        trustedProxyDepth: 1.5,
      })
    ).toBeUndefined();
    expect(
      getClientIp(requestWith({ 'X-Forwarded-For': '203.0.113.7' }), {
        trustedProxyDepth: Number.MAX_SAFE_INTEGER + 1,
      })
    ).toBeUndefined();
  });

  it('falls back to X-Real-IP when no X-Forwarded-For is present', () => {
    const ip = getClientIp(requestWith({ 'X-Real-IP': '192.0.2.1' }));
    expect(ip).toBe('192.0.2.1');
  });

  it('falls back to CF-Connecting-IP after X-Real-IP', () => {
    const ip = getClientIp(requestWith({ 'CF-Connecting-IP': '203.0.113.9' }));
    expect(ip).toBe('203.0.113.9');
  });

  it('prefers X-Forwarded-For over the single-proxy fallbacks', () => {
    const ip = getClientIp(
      requestWith({
        'CF-Connecting-IP': '203.0.113.7',
        'X-Forwarded-For': '198.51.100.1',
        'X-Real-IP': '192.0.2.1',
      })
    );
    expect(ip).toBe('198.51.100.1');
  });

  it('returns undefined when no proxy headers are present', () => {
    expect(getClientIp(requestWith({}))).toBeUndefined();
  });

  it('ignores blank header values and falls through', () => {
    expect(
      getClientIp(
        requestWith({ 'X-Forwarded-For': '   ', 'X-Real-IP': '192.0.2.1' })
      )
    ).toBe('192.0.2.1');
  });

  it('returns undefined when only a blank X-Forwarded-For is present', () => {
    expect(
      getClientIp(requestWith({ 'X-Forwarded-For': ' , , ' }))
    ).toBeUndefined();
  });
});
