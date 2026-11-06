import { expect, it } from 'vitest';
import { FatalError, RetryableError } from 'workflow';
import { failureCode } from '@/modules/kernel/domain/errors/failure-code';

it('recovers stable codes through the SDK retry-exhaustion wrapper and cycles', () => {
  const original = new RetryableError(
    'OBJECT_COPY_SOURCE_FAILED: safe source error'
  );
  const wrapped = new FatalError(
    `Step "pollStep" failed after 3 retries: ${original.message}`
  );
  wrapped.cause = original;
  expect(failureCode(wrapped, 'fallback')).toBe('OBJECT_COPY_SOURCE_FAILED');
  original.cause = wrapped;
  expect(failureCode(wrapped, 'fallback')).toBe('OBJECT_COPY_SOURCE_FAILED');
  const unknown = new Error('https://private.test/?secret=hidden');
  unknown.cause = unknown;
  expect(failureCode(unknown, 'fallback')).toBe('fallback');
});
