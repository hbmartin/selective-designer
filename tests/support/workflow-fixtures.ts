import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type WorkflowFixture = Readonly<{
  root: string;
  cwd: string;
  support: string;
  bin: string;
}>;

export function createWorkflowFixture(): WorkflowFixture {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'test-workflow-'))
  );
  const cwd = path.join(root, 'worktree');
  const support = path.join(root, 'support');
  const bin = path.join(support, 'bin');
  fs.mkdirSync(cwd);
  fs.mkdirSync(bin, { recursive: true });
  for (const file of [
    'git-global',
    'git-system',
    'git-ignore',
    'git-attributes',
  ]) {
    fs.writeFileSync(path.join(support, file), '', { mode: 0o600 });
  }
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  return Object.freeze({ root, cwd, support, bin });
}

function callerPath(parent: NodeJS.ProcessEnv) {
  return (parent.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
}

export function fixtureEnvironment(
  fixture: WorkflowFixture,
  parent: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: [fixture.bin, ...callerPath(parent)].join(path.delimiter),
    HOME: parent.HOME ?? os.homedir(),
    TMPDIR: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: path.join(fixture.support, 'git-system'),
    GIT_CONFIG_GLOBAL: path.join(fixture.support, 'git-global'),
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.excludesFile',
    GIT_CONFIG_VALUE_0: path.join(fixture.support, 'git-ignore'),
    GIT_CONFIG_KEY_1: 'core.attributesFile',
    GIT_CONFIG_VALUE_1: path.join(fixture.support, 'git-attributes'),
    pnpm_config_pm_on_fail: 'error',
    pnpm_config_verify_deps_before_run: 'false',
    pnpm_config_manage_package_manager_versions: 'false',
    npm_config_manage_package_manager_versions: 'false',
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENV_FILE: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_DEFAULT_TO_LATEST: '0',
  };
  for (const key of [
    'COREPACK_HOME',
    'PNPM_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
  ]) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  return env;
}

export function fixtureGit(fixture: WorkflowFixture, args: string[]) {
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
      cwd: fixture.cwd,
      encoding: 'utf8',
      timeout: 5_000,
      env: fixtureEnvironment(fixture),
    }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Fixture git ${args.join(' ')} failed in ${fixture.cwd}: ${result.error ?? result.stderr}`
    );
  }
  return result.stdout.trim();
}

type CommandOptions = {
  cwd?: string;
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
  abortReason?: string;
  error?: Error;
  stdout: string;
  stderr: string;
};

const runningCommands = new WeakMap<
  WorkflowFixture,
  Map<Promise<CommandResult>, () => void>
>();

export async function disposeFixtureCommands(fixture: WorkflowFixture) {
  const commands = runningCommands.get(fixture);
  if (!commands) return;
  for (const stop of commands.values()) stop();
  await Promise.allSettled(commands.keys());
}

export async function disposeWorkflowFixture(fixture: WorkflowFixture) {
  await disposeFixtureCommands(fixture);
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

export function describeCommand(result: CommandResult) {
  return [
    `Command: ${result.command}`,
    `Working directory: ${result.cwd}`,
    `Exit: ${result.status}; signal: ${result.signal}; timeout: ${result.timedOut}; aborted: ${result.aborted}`,
    `Cancellation: ${result.abortReason ?? 'none'}`,
    `Spawn error: ${result.error?.message ?? 'none'}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join('\n');
}

export function runFixtureCommand(
  command: string,
  args: string[],
  fixture: WorkflowFixture,
  {
    cwd = fixture.cwd,
    env = fixtureEnvironment(fixture),
    timeoutMs = 5_000,
    terminationGraceMs = 2_000,
    signal,
  }: CommandOptions = {}
): Promise<CommandResult> {
  const result: CommandResult = {
    command: [command, ...args].join(' '),
    cwd,
    status: null,
    signal: null,
    timedOut: false,
    aborted: signal?.aborted ?? false,
    stdout: '',
    stderr: '',
  };
  if (signal?.aborted) {
    result.abortReason = String(signal.reason);
    return Promise.resolve(result);
  }
  let stopRunning = () => {};
  const completion = new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (killSignal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, killSignal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          result.error ??= error as Error;
      }
    };
    const stop = (reason: 'timedOut' | 'aborted', detail?: string) => {
      if (result.timedOut || result.aborted) return;
      result[reason] = true;
      result.abortReason = detail;
      killGroup('SIGTERM');
      escalation = setTimeout(() => killGroup('SIGKILL'), terminationGraceMs);
    };
    const deadline = setTimeout(() => stop('timedOut'), timeoutMs);
    const onAbort = () => stop('aborted', String(signal?.reason));
    stopRunning = () => stop('aborted', 'Fixture disposed');
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
      if (result.timedOut || result.aborted) killGroup('SIGKILL');
      result.status = status;
      result.signal = exitSignal;
      resolve(result);
    });
  });
  const commands =
    runningCommands.get(fixture) ??
    new Map<Promise<CommandResult>, () => void>();
  runningCommands.set(fixture, commands);
  commands.set(completion, () => stopRunning());
  return completion.finally(() => {
    commands.delete(completion);
    if (commands.size === 0) runningCommands.delete(fixture);
  });
}

export function runFixtureShell(
  script: string,
  fixture: WorkflowFixture,
  options: CommandOptions = {}
) {
  return runFixtureCommand(
    '/bin/bash',
    ['-e', '-o', 'pipefail', '-c', script],
    fixture,
    options
  );
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function pnpmFixtureEnvironment(
  fixture: WorkflowFixture,
  packageManager: string,
  parent: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal
) {
  const expectedVersion = /^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(
    packageManager
  )?.[1];
  if (!expectedVersion) throw new Error(`Invalid pnpm pin: ${packageManager}`);
  const candidate = callerPath(parent)
    .map((directory) => path.join(directory, 'pnpm'))
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
      `pnpm ${expectedVersion} is required for workflow fixtures but was not found on PATH. Put the project's already-installed pinned pnpm on PATH before running tests; automatic downloads and switching are disabled.`
    );
  }
  if (candidate === path.join(fixture.bin, 'pnpm'))
    throw new Error(
      'Resolve pnpm from the caller PATH, not the private fixture bin.'
    );
  const env = fixtureEnvironment(fixture, parent);
  const version = await runFixtureCommand(candidate, ['--version'], fixture, {
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
      `Expected pnpm ${expectedVersion} from ${candidate}. Put the project's already-installed pinned pnpm on PATH; automatic downloads and switching are disabled.\n${describeCommand(version)}`
    );
  }
  fs.writeFileSync(
    path.join(fixture.bin, 'pnpm'),
    `#!/bin/sh\nexec ${shellQuote(candidate)} "$@"\n`,
    { mode: 0o700 }
  );
  return env;
}
