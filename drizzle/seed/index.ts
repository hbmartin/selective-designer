import { faker } from '@faker-js/faker';

import {
  operatorPasswordSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@/modules/auth';
import { ConfigurationError } from '@/modules/kernel';
import {
  assertLocalSeedTarget,
  getDatabaseErrorCode,
  getDefaultDbClient,
  getSeedAccountEmails,
  getSeedAccountPassword,
} from '@/modules/kernel/backend';
import { errorCauses } from '@/modules/kernel/domain/errors/error-causes';

const connectionErrorCodes = new Set([
  'EADDRNOTAVAIL',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function getSeedErrorCode(error: unknown): string | undefined {
  const sqlState = getDatabaseErrorCode(error);
  if (sqlState) return sqlState;

  for (const cause of errorCauses(error)) {
    if (typeof cause.code === 'string' && connectionErrorCodes.has(cause.code))
      return cause.code;
  }
  return undefined;
}

function reportFailure(message: string, error: unknown) {
  process.exitCode = 1;
  if (error instanceof ConfigurationError) {
    console.error(error.message);
    return;
  }

  const code = getSeedErrorCode(error);
  console.error(code ? `${message} (${code})` : message);
}

async function main() {
  assertLocalSeedTarget();
  const emails = getSeedAccountEmails();
  const password = operatorPasswordSchema.safeParse(getSeedAccountPassword());
  if (!password.success) {
    throw new ConfigurationError(
      `SEED_ACCOUNT_PASSWORD must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters long.`
    );
  }
  const db = getDefaultDbClient();
  try {
    const { createUsers } = await import('./user');
    faker.seed(0x5eed);
    await createUsers(db, { ...emails, password: password.data });
  } catch (error) {
    reportFailure('Database seed failed.', error);
  } finally {
    try {
      await db.$close();
    } catch (error) {
      reportFailure('Closing the seed database connection failed.', error);
    }
  }
}

try {
  await main();
} catch (error) {
  reportFailure('Database seed failed.', error);
}
