import { createTransactionRunner } from './client';
import type { Database, DbTransaction } from './types';
import type { ApplicationResult } from '../../application/result';

/** Repository callbacks must reject the transaction when returning a boxed failure. */
export const runRepositoryTransaction = <T>(
  db: Database,
  operation: (tx: DbTransaction) => Promise<ApplicationResult<T>>
) =>
  createTransactionRunner(db).run(async (tx) => {
    const result = await operation(tx);
    if (result.isError()) throw result.getError();
    return result;
  });
