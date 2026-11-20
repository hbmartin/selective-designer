import { spawnSync } from 'node:child_process';

import {
  pnpmCommand,
  resolvePnpmCliPath,
} from './check-license-compliance.mjs';

const buildEnvironment = { ...process.env, NODE_ENV: 'production' };
if (
  buildEnvironment.VERCEL_ENV === 'preview' &&
  !buildEnvironment.VITE_BASE_URL?.trim()
) {
  const host =
    buildEnvironment.VERCEL_BRANCH_URL?.trim() ||
    buildEnvironment.VERCEL_URL?.trim();
  if (host) buildEnvironment.VITE_BASE_URL = `https://${host}`;
}

function runScript(script) {
  console.log(`Running release stage: ${script}`);
  const command = pnpmCommand(resolvePnpmCliPath(), [script]);
  const result = spawnSync(command.file, command.args, {
    stdio: 'inherit',
    env: buildEnvironment,
  });

  if (result.error || result.status !== 0) {
    console.error(`Release stage failed: ${script}`);
    process.exit(result.status ?? 1);
  }
}

runScript('build');

if (process.env.VERCEL_ENV === 'production') {
  runScript('db:migrate');
}
