import { describe, expect, it } from 'vitest';

import {
  classifyDatabaseFailure,
  extractDatabaseErrorDetails,
  getConstraintName,
  getDatabaseErrorCode,
  getErrorDetail,
  isUniqueConstraintViolation,
  withDatabaseErrorDetails,
} from '@/modules/kernel/infrastructure/db/db-error-details';

describe('database error details', () => {
  it('extracts direct Postgres fields', () => {
    const error = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'user_email_key',
      detail: 'Key (email) already exists.',
      hint: 'Use another email.',
      severity: 'ERROR',
    });

    expect(extractDatabaseErrorDetails(error)).toMatchObject({
      name: 'Error',
      message: 'duplicate key',
      code: '23505',
      constraint: 'user_email_key',
      detail: 'Key (email) already exists.',
      hint: 'Use another email.',
      severity: 'ERROR',
    });
    expect(isUniqueConstraintViolation(error)).toBe(true);
    expect(getConstraintName(error)).toBe('user_email_key');
    expect(getErrorDetail(error)).toBe('Key (email) already exists.');
  });

  it('extracts wrapped cause fields', () => {
    const cause = Object.assign(new Error('driver detail'), {
      code: '23505',
      constraint: 'design_name_owner_key',
      detail: 'Key (name, owner) already exists.',
    });
    const error = new Error('drizzle wrapper', { cause });

    expect(extractDatabaseErrorDetails(error)).toMatchObject({
      message: 'drizzle wrapper',
      cause: 'driver detail',
      code: '23505',
      constraint: 'design_name_owner_key',
    });
    expect(isUniqueConstraintViolation(error)).toBe(true);
    expect(getConstraintName(error)).toBe('design_name_owner_key');
  });

  it('keeps context unchanged when no database details exist', () => {
    const context = { operation: 'users.list' };

    expect(withDatabaseErrorDetails(context, 'plain failure')).toBe(context);
  });
});

it.each([
  '2B000',
  '2D000',
  '2F005',
  '3B001',
  '3D000',
  '3F000',
  'P0001',
  'HV000',
  'XX000',
])('finds SQLSTATE %s through application wrappers', (code) => {
  const cause = Object.assign(new Error('driver'), { code });
  const error = Object.assign(
    new Error('application', { cause: new Error('drizzle', { cause }) }),
    { code: 'APP_ERROR' }
  );
  expect(getDatabaseErrorCode(error)).toBe(code);
  expect(classifyDatabaseFailure(error)).toMatchObject({
    publication: 'unknown',
    retryableRollback: false,
  });
});
it.each(['40001', '40P01', '55P03'])(
  'recognizes confirmed retryable rollback %s',
  (code) => {
    expect(
      classifyDatabaseFailure({ cause: { cause: { code } } })
    ).toMatchObject({ publication: 'rejected', retryableRollback: true });
  }
);
it.each(['EPIPE', 'ECONNRESET', '08006', '40003', '57P01'])(
  'preserves uncertainty for %s',
  (code) => {
    expect(classifyDatabaseFailure({ code })).toMatchObject({
      publication: 'unknown',
      retryableRollback: false,
    });
  }
);
it('terminates a cyclic cause chain', () => {
  const error: { cause?: unknown } = {};
  error.cause = error;
  expect(getDatabaseErrorCode(error)).toBeUndefined();
});
