import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pnpmCommand } from '../../scripts/lib/pnpm.mjs';

/** Use installed tools only, including when the first PATH entry is a Corepack shim. */
export function pinnedTestPnpmEnvironment(parent: NodeJS.ProcessEnv) {
  return {
    ...parent,
    pnpm_config_pm_on_fail: 'error',
    pnpm_config_manage_package_manager_versions: 'false',
    npm_config_manage_package_manager_versions: 'false',
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENV_FILE: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_DEFAULT_TO_LATEST: '0',
  };
}

export function resolvePinnedTestPnpm(
  packageManager: string,
  parent: NodeJS.ProcessEnv = process.env
) {
  const expected = /^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(packageManager)?.[1];
  if (!expected) throw new Error(`Invalid pnpm pin: ${packageManager}`);
  const candidate = (parent.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.resolve(directory, 'pnpm'))
    .find((file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
  if (!candidate)
    throw new Error(
      `pnpm ${expected} was not found on PATH. Expose the already-installed pinned pnpm; downloads and switching are disabled.`
    );
  const command = pnpmCommand(candidate, ['--version']);
  const result = spawnSync(command.file, command.args, {
    env: pinnedTestPnpmEnvironment(parent),
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Unable to verify pnpm ${expected} from ${candidate}: ${result.error?.message ?? `exit ${result.status}`}`
    );
  if (result.stdout.trim() !== expected)
    throw new Error(
      `Expected pnpm ${expected} from the first PATH candidate (${candidate}); found ${result.stdout.trim()}. Automatic downloads and switching are disabled.`
    );
  return candidate;
}
