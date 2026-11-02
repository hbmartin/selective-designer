import { describe, expect, it } from 'vitest';

import {
  exceedsDeclaredBodyLimit,
  MAX_SERVER_FN_BODY_BYTES,
  violatesServerFnBodyLimit,
} from '@/platform/http/request-body-limit';

const requestWithContentLength = (value: string | null) =>
  new Request('https://app.example/_server', {
    method: 'POST',
    headers: value === null ? {} : { 'Content-Length': value },
  });

describe('exceedsDeclaredBodyLimit', () => {
  it('flags a declared Content-Length above the limit', () => {
    expect(
      exceedsDeclaredBodyLimit(
        requestWithContentLength(String(MAX_SERVER_FN_BODY_BYTES + 1))
      )
    ).toBe(true);
  });

  it('allows a declared Content-Length at or below the limit', () => {
    expect(
      exceedsDeclaredBodyLimit(
        requestWithContentLength(String(MAX_SERVER_FN_BODY_BYTES))
      )
    ).toBe(false);
    expect(exceedsDeclaredBodyLimit(requestWithContentLength('10'))).toBe(
      false
    );
  });

  it('does not flag a missing or unparseable Content-Length by itself', () => {
    expect(exceedsDeclaredBodyLimit(requestWithContentLength(null))).toBe(
      false
    );
    expect(
      exceedsDeclaredBodyLimit(requestWithContentLength('not-a-number'))
    ).toBe(false);
  });

  it('honours an explicit lower bound', () => {
    expect(exceedsDeclaredBodyLimit(requestWithContentLength('100'), 50)).toBe(
      true
    );
  });
});

describe('violatesServerFnBodyLimit', () => {
  it('fails closed for POST requests without Content-Length', () => {
    expect(violatesServerFnBodyLimit(requestWithContentLength(null))).toBe(
      true
    );
  });

  it('fails closed for invalid Content-Length values', () => {
    for (const value of ['', ' ', '-1', '1.5', '1e6', '0x10', 'not-a-number']) {
      expect(violatesServerFnBodyLimit(requestWithContentLength(value))).toBe(
        true
      );
    }
  });

  it('allows safe methods without Content-Length', () => {
    expect(
      violatesServerFnBodyLimit(
        new Request('https://app.example/_server', { method: 'GET' })
      )
    ).toBe(false);
  });

  it('allows declared POST bodies at the limit', () => {
    expect(violatesServerFnBodyLimit(requestWithContentLength('50'), 50)).toBe(
      false
    );
  });
});
