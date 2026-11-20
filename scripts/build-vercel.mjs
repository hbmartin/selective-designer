import { spawnSync } from 'node:child_process';

import {
  pnpmCommand,
  resolvePnpmCliPath,
} from './check-license-compliance.mjs';

function runScript(script) {
  console.log(`Running release stage: ${script}`);
  const command = pnpmCommand(resolvePnpmCliPath(), [script]);
  const result = spawnSync(command.file, command.args, {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
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
