import { faker } from '@faker-js/faker';

import {
  assertLocalSeedTarget,
  getDefaultDbClient,
} from '@/modules/kernel/backend';

import { createUsers } from './user';

async function main() {
  assertLocalSeedTarget();
  const db = getDefaultDbClient();
  try {
    faker.seed(0x5eed);
    await createUsers();
  } finally {
    await db.$close();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Database seed failed.'
  );
  process.exitCode = 1;
}
