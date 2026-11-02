import { faker } from '@faker-js/faker';

import {
  getDefaultDbClient,
  isProdRuntimeEnvironment,
  isProductionSeedAllowed,
} from '@/modules/kernel/backend';

import { createUsers } from './user';

const SEED = 0x5eed;

/**
 * The seed provisions stable local accounts (see ./user.ts). Running it
 * against a production database would plant non-production users, so refuse
 * unless the operator explicitly opts in with ALLOW_PROD_SEED=true.
 */
function assertSeedAllowed() {
  if (isProdRuntimeEnvironment() && !isProductionSeedAllowed()) {
    throw new Error(
      'Refusing to seed in a production environment. This would create demo ' +
        'accounts. Set ALLOW_PROD_SEED=true to override.'
    );
  }
}

async function main() {
  assertSeedAllowed();
  faker.seed(SEED);
  await createUsers();
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await getDefaultDbClient().$close();
  } catch (closeError) {
    console.error(closeError);
    process.exitCode = 1;
  }
}
