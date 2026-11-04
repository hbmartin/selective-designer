import { faker } from '@faker-js/faker';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/modules/auth';
import { ConfigurationError } from '@/modules/kernel';
import {
  assertLocalSeedTarget,
  getDatabaseErrorCode,
  getDefaultDbClient,
  getSeedAccountPassword,
} from '@/modules/kernel/backend';

function reportFailure(message: string, error: unknown) {
  const code = getDatabaseErrorCode(error);
  console.error(
    error instanceof ConfigurationError
      ? error.message
      : code && /^[A-Z0-9_]{3,32}$/u.test(code)
        ? `${message} (${code})`
        : message
  );
  process.exitCode = 1;
}

async function main() {
  assertLocalSeedTarget();
  const password = getSeedAccountPassword();
  if (
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    throw new ConfigurationError(
      `SEED_ACCOUNT_PASSWORD must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters long.`
    );
  }
  const db = getDefaultDbClient();
  try {
    const { createUsers } = await import('./user');
    faker.seed(0x5eed);
    await createUsers(password);
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
