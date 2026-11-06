import { describe, expect, it } from 'vitest';

import { AppError } from '@/modules/kernel';
import { actionableErrorCode } from '@/modules/kernel/domain/errors/actionable-error-code';
import { safeErrorDiagnostics } from '@/modules/kernel/domain/errors/safe-error-diagnostics';

describe('safe actionable accounting diagnostics', () => {
  it('prefers a semantic identity cause and otherwise retains nested SQLSTATE and transport codes', () => {
    const semantic = new AppError({
      code: 'PROVIDER_CALL_IDENTITY_MISMATCH',
      category: 'system',
      status: 500,
    });
    expect(
      actionableErrorCode(
        new Error('wrapper', { cause: semantic }),
        'ACCOUNTING_FAILED'
      )
    ).toBe('PROVIDER_CALL_IDENTITY_MISMATCH');
    for (const code of ['55P03', 'EPIPE']) {
      const nested = Object.assign(new Error('postgres://secret@private'), {
        code,
      });
      const error = new AppError({
        code: 'PROVIDER_ACCOUNTING_FAILED',
        category: 'system',
        status: 500,
        cause: new AppError({
          code: 'PROVIDER_CALL_LOG_FAILED',
          category: 'system',
          status: 500,
          cause: nested,
        }),
      });
      expect(actionableErrorCode(error, 'PROVIDER_ACCOUNTING_FAILED')).toBe(
        code
      );
      expect(JSON.stringify(safeErrorDiagnostics(error))).not.toContain(
        'secret'
      );
    }
  });
  it('terminates on cyclic causes and ignores unsafe identifiers', () => {
    const error = { code: 'secret?token=private', cause: {} as unknown };
    error.cause = error;
    expect(actionableErrorCode(error, 'ACCOUNTING_FAILED')).toBe(
      'ACCOUNTING_FAILED'
    );
  });
});
