import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function fixtureEnvironment(
  root: string,
  parent: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const configDirectory = path.join(root, '.fixture-environment');
  fs.mkdirSync(configDirectory, { recursive: true });
  const emptyConfig = path.join(configDirectory, 'gitconfig');
  if (!fs.existsSync(emptyConfig)) fs.writeFileSync(emptyConfig, '');

  return {
    PATH: [
      path.join(root, 'node_modules/.bin'),
      path.dirname(process.execPath),
      parent.PATH ?? '',
    ].join(path.delimiter),
    HOME: parent.HOME ?? os.homedir(),
    TMPDIR: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_GLOBAL: emptyConfig,
    npm_config_verify_deps_before_run: 'false',
  };
}

export function fixtureGit(root: string, args: string[]) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Workflow Fixture',
      '-c',
      'user.email=workflow@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000,
      env: fixtureEnvironment(root),
    }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Fixture git ${args.join(' ')} failed in ${root}: ${result.error ?? result.stderr}`
    );
  }
  return result.stdout.trim();
}

type CommandOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  terminationGraceMs?: number;
  signal?: AbortSignal;
};

type CommandResult = {
  command: string;
  cwd: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  error?: Error;
  stdout: string;
  stderr: string;
};

const runningCommands = new Map<
  string,
  Map<Promise<CommandResult>, () => void>
>();

export async function disposeFixtureCommands(root: string) {
  const commands = runningCommands.get(root);
  if (!commands) return;
  for (const stop of commands.values()) stop();
  await Promise.allSettled(commands.keys());
}

export function describeCommand(result: CommandResult) {
  return [
    `Command: ${result.command}`,
    `Working directory: ${result.cwd}`,
    `Exit: ${result.status}; signal: ${result.signal}; timeout: ${result.timedOut}; aborted: ${result.aborted}`,
    `Spawn error: ${result.error?.message ?? 'none'}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join('\n');
}

export function runFixtureCommand(
  command: string,
  args: string[],
  cwd: string,
  {
    env = fixtureEnvironment(cwd),
    timeoutMs = 5_000,
    terminationGraceMs = 2_000,
    signal,
  }: CommandOptions = {}
): Promise<CommandResult> {
  let stopRunning = () => {};
  const completion = new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result: CommandResult = {
      command: [command, ...args].join(' '),
      cwd,
      status: null,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: '',
      stderr: '',
    };
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (killSignal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, killSignal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          result.error ??= error as Error;
        }
      }
    };
    const stop = (reason: 'timedOut' | 'aborted') => {
      if (result.timedOut || result.aborted) return;
      result[reason] = true;
      killGroup('SIGTERM');
      escalation = setTimeout(() => killGroup('SIGKILL'), terminationGraceMs);
    };
    const deadline = setTimeout(() => stop('timedOut'), timeoutMs);
    const onAbort = () => stop('aborted');
    stopRunning = onAbort;
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    // Bound retained output while continuing to drain both pipes.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      result.stdout = (result.stdout + chunk).slice(-1_048_576);
    });
    child.stderr.on('data', (chunk: string) => {
      result.stderr = (result.stderr + chunk).slice(-1_048_576);
    });
    child.on('error', (error) => {
      result.error = error;
    });
    child.on('close', (status, exitSignal) => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', onAbort);
      // A descendant may have closed its pipes before the group leader exited.
      if (result.timedOut || result.aborted) killGroup('SIGKILL');
      result.status = status;
      result.signal = exitSignal;
      resolve(result);
    });
  });
  const commands =
    runningCommands.get(cwd) ?? new Map<Promise<CommandResult>, () => void>();
  runningCommands.set(cwd, commands);
  commands.set(completion, () => stopRunning());
  return completion.finally(() => {
    commands.delete(completion);
    if (commands.size === 0) runningCommands.delete(cwd);
  });
}

export function runFixtureShell(
  script: string,
  cwd: string,
  options: CommandOptions = {}
) {
  return runFixtureCommand(
    'bash',
    ['-e', '-o', 'pipefail', '-c', script],
    cwd,
    options
  );
}

export async function pnpmFixtureEnvironment(
  root: string,
  packageManager: string,
  env = fixtureEnvironment(root),
  signal?: AbortSignal
) {
  const expectedVersion = /^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(
    packageManager
  )?.[1];
  if (!expectedVersion) throw new Error(`Invalid pnpm pin: ${packageManager}`);
  const candidate = (env.PATH ?? '')
    .split(path.delimiter)
    .map((directory) => path.resolve(root, directory, 'pnpm'))
    .find((file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
  if (!candidate) {
    throw new Error(
      `pnpm ${expectedVersion} is required for workflow fixtures but was not found on PATH. Make the project's pinned pnpm available before running tests.`
    );
  }
  const version = await runFixtureCommand(candidate, ['--version'], root, {
    env,
    timeoutMs: 10_000,
    signal,
  });
  if (
    version.error ||
    version.status !== 0 ||
    version.timedOut ||
    version.aborted ||
    version.stdout.trim() !== expectedVersion
  ) {
    throw new Error(
      `Expected pnpm ${expectedVersion} from ${candidate}. Make the project's pinned pnpm available.\n${describeCommand(version)}`
    );
  }
  return {
    ...env,
    PATH: [
      path.join(root, 'node_modules/.bin'),
      path.dirname(process.execPath),
      path.dirname(candidate),
      env.PATH,
    ].join(path.delimiter),
  };
}
