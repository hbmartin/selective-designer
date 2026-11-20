import { spawnSync } from 'node:child_process';

import { pnpmCommand, resolvePnpmCliPath } from './lib/pnpm.mjs';

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
    if (result.error) console.error(result.error.message);
    if (result.signal)
      console.error(`Release subprocess terminated by ${result.signal}`);
    process.exitCode = result.status || 1;
    return false;
  }
  return true;
}

try {
  const target = buildEnvironment.VERCEL_ENV;
  if (target !== 'production' && target !== 'preview') {
    throw new Error(
      'build:vercel requires VERCEL_ENV=production or preview. Enable Vercel system environment variables; use pnpm build for local builds.'
    );
  }
  if (
    buildEnvironment.VERCEL_TARGET_ENV !== undefined &&
    buildEnvironment.VERCEL_TARGET_ENV !== target
  ) {
    throw new Error(
      'VERCEL_TARGET_ENV must match VERCEL_ENV. Custom and contradictory release targets are unsupported.'
    );
  }
  if (target === 'preview')
    console.log('Preview release: database migrations are disabled.');
  if (target === 'preview' || runScript('db:validate-migration-config')) {
    if (runScript('build') && target === 'production') runScript('db:migrate');
  }
} catch (error) {
  console.error(
    `Release command failed: ${error instanceof Error ? error.message : 'unknown launch failure'}`
  );
  process.exitCode = 1;
}
