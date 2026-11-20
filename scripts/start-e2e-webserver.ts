import { spawnSync } from 'node:child_process';
import { configureE2EDatabase } from '../tests/server/e2e-database-config';

const config = configureE2EDatabase();
const result = spawnSync(
  'pglite-server',
  [
    '--db=memory://',
    `--port=${config.port}`,
    '--max-connections=16',
    '--run',
    'pnpm e2e:dev',
    '--shutdown-timeout=10000',
  ],
  { stdio: 'inherit', env: process.env }
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
