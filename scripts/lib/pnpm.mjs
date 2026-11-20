import path from 'node:path';

export function resolvePnpmCliPath(env = process.env) {
  const npmExecPath = env.npm_execpath;
  if (!npmExecPath) {
    throw new Error('Unable to locate pnpm CLI. Run this script through pnpm.');
  }

  if (!path.isAbsolute(npmExecPath)) {
    throw new Error('Refusing to execute a non-absolute package-manager path.');
  }

  if (!path.basename(npmExecPath).toLowerCase().includes('pnpm')) {
    throw new Error('This command must be run by pnpm.');
  }

  return npmExecPath;
}

/**
 * `npm_execpath` is a JS entry point for npm-installed pnpm, but a native
 * executable for standalone installs (`@pnpm/exe`); run each accordingly.
 */
export function pnpmCommand(pnpmCliPath, args, nodePath = process.execPath) {
  return /\.(?:c|m)?js$/u.test(pnpmCliPath)
    ? { file: nodePath, args: [pnpmCliPath, ...args] }
    : { file: pnpmCliPath, args };
}
