import { faker } from '@faker-js/faker';

import { ConfigurationError } from '@/modules/kernel';
import {
  assertLocalSeedTarget,
  getDatabaseErrorCode,
  getDefaultDbClient,
} from '@/modules/kernel/backend';

import { createUsers } from './user';

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
  const db = getDefaultDbClient();
  try {
    faker.seed(0x5eed);
    await createUsers();
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
