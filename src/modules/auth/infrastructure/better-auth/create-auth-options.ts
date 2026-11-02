import type { Database } from '@/modules/kernel/infrastructure/db/client';

import type { AuthEmailPort } from '../../application/ports/auth-email-port';
import type { SecondaryStore } from '../../application/ports/secondary-store';

export type CreateAuthOptions = {
  database?: Database;
  authEmailPort?: AuthEmailPort;
  secondaryStore?: SecondaryStore;
};

const hasDatabaseShape = (input: unknown): input is Database =>
  typeof input === 'object' &&
  input !== null &&
  typeof (input as { select?: unknown }).select === 'function';

export function normalizeCreateAuthInput(
  input?: Database | CreateAuthOptions | null
): CreateAuthOptions {
  if (input === undefined || input === null) return {};
  return hasDatabaseShape(input) ? { database: input } : input;
}
