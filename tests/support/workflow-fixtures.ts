import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fixtureGroupIsLive,
  inspectFixtureProcesses,
  signalFixtureGroup,
  validateDetachedFixtureGroup,
  type FixtureProcessGroup,
} from './fixture-process-groups';

export type WorkflowFixture = Readonly<{
  root: string;
  cwd: string;
  support: string;
  bin: string;
}>;

export function createWorkflowFixture(): WorkflowFixture {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'test-workflow-')
  );
  try {
    const root = fs.realpathSync(temporaryRoot);
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
    const fixture = Object.freeze({ root, cwd, support, bin });
    fixtureStates.set(fixture, {
      closing: false,
      disposed: false,
      commands: new Map(),
      groups: new Set(),
    });
    return fixture;
  } catch (error) {
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Fixture construction and cleanup failed: ${temporaryRoot}`
      );
    }
    throw error;
  }
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
  spawnError?: Error;
  cleanupError?: Error;
  stdout: string;
  stderr: string;
};

type OwnedGroup = FixtureProcessGroup & { owner: CommandControl };
type CommandControl = {
  pid?: number;
  exited: boolean;
  stop: () => void;
};
type FixtureState = {
  closing: boolean;
  disposed: boolean;
  commands: Map<Promise<CommandResult>, CommandControl>;
  groups: Set<OwnedGroup>;
  disposal?: Promise<void>;
};
const fixtureStates = new WeakMap<WorkflowFixture, FixtureState>();
function fixtureState(fixture: WorkflowFixture) {
  const state = fixtureStates.get(fixture);
  if (!state) throw new Error(`Unknown workflow fixture: ${fixture.root}`);
  return state;
}
function requireOpenFixture(fixture: WorkflowFixture) {
  const state = fixtureState(fixture);
  if (state.closing)
    throw new Error(`Workflow fixture is closing or disposed: ${fixture.root}`);
  return state;
}

export async function registerFixtureProcessGroup(
  fixture: WorkflowFixture,
  pid: number
): Promise<void> {
  const state = requireOpenFixture(fixture);
  const rows = inspectFixtureProcesses();
  const existing = [...state.groups].find((group) => group.pid === pid);
  if (existing) {
    if (!fixtureGroupIsLive(existing, rows))
      throw new Error(`Fixture group ${pid} has stopped`);
    return;
  }
  const active = [...state.commands.values()].filter((command) => {
    const row = command.pid === undefined ? undefined : rows.get(command.pid);
    return !command.exited && row !== undefined && !row.state.startsWith('Z');
  });
  for (const group of state.groups) {
    if (active.includes(group.owner)) fixtureGroupIsLive(group, rows);
  }
  const group = validateDetachedFixtureGroup(
    pid,
    new Set(active.map((command) => command.pid!)),
    rows
  );
  let row = rows.get(pid);
  while (row && !active.some((command) => command.pid === row!.pid))
    row = rows.get(row.parent);
  const owner = active.find((command) => command.pid === row?.pid)!;
  state.groups.add({ ...group, owner });
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
async function stopGroups(
  state: FixtureState,
  groups: OwnedGroup[],
  graceMs: number
) {
  if (!groups.length) return;
  const errors: unknown[] = [];
  let remaining = groups;
  const inspect = () => {
    const rows = inspectFixtureProcesses();
    remaining = remaining.filter((group) => {
      try {
        if (fixtureGroupIsLive(group, rows)) return true;
        state.groups.delete(group);
      } catch (error) {
        errors.push(error);
      }
      return false;
    });
    return rows;
  };
  try {
    let rows = inspect();
    for (const group of remaining) {
      try {
        signalFixtureGroup(group, 'SIGTERM', rows);
      } catch (error) {
        errors.push(error);
      }
    }
    const until = performance.now() + graceMs;
    while (remaining.length && performance.now() < until) {
      await pause(Math.min(50, Math.max(0, until - performance.now())));
      rows = inspect();
    }
    for (const group of remaining) {
      try {
        signalFixtureGroup(group, 'SIGKILL', rows);
      } catch (error) {
        errors.push(error);
      }
    }
    const finalUntil = performance.now() + 1_000;
    while (remaining.length && performance.now() < finalUntil) {
      await pause(25);
      inspect();
    }
    if (remaining.length)
      throw new Error(
        `Fixture groups still live: ${remaining.map((group) => group.pid).join(', ')}`
      );
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `Fixture process cleanup could not be confirmed: ${errors.map(String).join('; ')}`
    );
}

export async function disposeFixtureCommands(fixture: WorkflowFixture) {
  const state = fixtureState(fixture);
  state.closing = true;
  for (const command of state.commands.values()) command.stop();
  const results = await Promise.allSettled(state.commands.keys());
  const errors = results.flatMap((result) =>
    result.status === 'rejected'
      ? [result.reason]
      : result.value.cleanupError
        ? [result.value.cleanupError]
        : []
  );
  if (errors.length)
    throw new AggregateError(
      errors,
      `Fixture command cleanup failed: ${fixture.root}`
    );
  if (state.groups.size) await stopGroups(state, [...state.groups], 2_000);
}

export function disposeWorkflowFixture(
  fixture: WorkflowFixture
): Promise<void> {
  const state = fixtureState(fixture);
  if (state.disposed) return Promise.resolve();
  if (state.disposal) return state.disposal;
  state.closing = true;
  const disposal = (async () => {
    try {
      await disposeFixtureCommands(fixture);
      fs.rmSync(fixture.root, { recursive: true, force: true });
      state.disposed = true;
    } catch (error) {
      throw new Error(`Fixture cleanup failed; retained ${fixture.root}`, {
        cause: error,
      });
    }
  })();
  state.disposal = disposal;
  void disposal
    .finally(() => {
      state.disposal = undefined;
    })
    .catch(() => {});
  return disposal;
}

export async function disposeWorkflowFixtures(
  fixtures: WorkflowFixture[],
  restore = () => {}
) {
  try {
    const pending = fixtures.splice(0);
    const results = await Promise.allSettled(
      pending.map(disposeWorkflowFixture)
    );
    const errors = results.flatMap((result, index) => {
      if (result.status !== 'rejected') return [];
      fixtures.push(pending[index]!);
      return [result.reason];
    });
    if (errors.length)
      throw new AggregateError(
        errors,
        'Workflow fixture collection cleanup failed'
      );
  } finally {
    restore();
  }
}

export function describeCommand(result: CommandResult) {
  return [
    `Command: ${result.command}`,
    `Working directory: ${result.cwd}`,
    `Exit: ${result.status}; signal: ${result.signal}; timeout: ${result.timedOut}; aborted: ${result.aborted}`,
    `Cancellation: ${result.abortReason ?? 'none'}`,
    `Error: ${result.error?.message ?? 'none'}`,
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
  const state = requireOpenFixture(fixture);
  const control: CommandControl = { exited: false, stop: () => {} };
  const completion = new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    control.pid = child.pid;
    const rootGroup =
      child.pid === undefined
        ? undefined
        : {
            pid: child.pid,
            owner: control,
            started: undefined as string | undefined,
          };
    if (rootGroup) state.groups.add(rootGroup);
    let closed = false;
    let settled = false;
    let cleanup: Promise<void> | undefined;
    let executionDeadline: ReturnType<typeof setTimeout>;
    let drainDeadline: ReturnType<typeof setTimeout> | undefined;
    let onClose = () => {};
    const addError = (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      result.error = result.error
        ? new AggregateError(
            [result.error, failure],
            `Fixture command failed: ${result.error.message}; ${failure.message}`
          )
        : failure;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(executionDeadline);
      clearTimeout(drainDeadline);
      signal?.removeEventListener('abort', onAbort);
      child.removeAllListeners('spawn');
      child.removeAllListeners('exit');
      child.removeAllListeners('close');
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      child.unref();
      resolve(result);
    };
    const startCleanup = () => {
      if (cleanup) return;
      clearTimeout(executionDeadline);
      const cleanupUntil = performance.now() + terminationGraceMs + 1_000;
      cleanup = (async () => {
        try {
          await stopGroups(
            state,
            [...state.groups].filter((group) => group.owner === control),
            terminationGraceMs
          );
        } catch (error) {
          result.cleanupError =
            error instanceof Error ? error : new Error(String(error));
          addError(error);
        }
        if (!closed) {
          await new Promise<void>((drained) => {
            onClose = drained;
            drainDeadline = setTimeout(
              () => {
                result.cleanupError = new Error(
                  'Fixture stdout/stderr did not close; unregistered daemonization is unsupported'
                );
                addError(result.cleanupError);
                child.stdout.destroy();
                child.stderr.destroy();
                child.unref();
                drained();
              },
              Math.max(0, cleanupUntil - performance.now())
            );
          });
        }
        finish();
      })();
    };
    const stop = (reason: 'timedOut' | 'aborted', detail?: string) => {
      if (settled || cleanup) return;
      result[reason] = true;
      result.abortReason = detail;
      startCleanup();
    };
    const onAbort = () => stop('aborted', String(signal?.reason));
    control.stop = () => stop('aborted', 'Fixture disposed');
    executionDeadline = setTimeout(() => stop('timedOut'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      result.stdout = (result.stdout + chunk).slice(-1_048_576);
    });
    child.stderr.on('data', (chunk: string) => {
      result.stderr = (result.stderr + chunk).slice(-1_048_576);
    });
    child.on('error', (error) => {
      if (settled) return;
      result.spawnError = error;
      addError(error);
      startCleanup();
    });
    child.once('spawn', () => {
      try {
        if (rootGroup)
          rootGroup.started = inspectFixtureProcesses().get(
            rootGroup.pid
          )?.started;
      } catch (error) {
        addError(error);
        startCleanup();
      }
    });
    child.on('exit', (status, exitSignal) => {
      control.exited = true;
      result.status = status;
      result.signal = exitSignal;
      startCleanup();
    });
    child.on('close', () => {
      closed = true;
      onClose();
    });
  });
  state.commands.set(completion, control);
  return completion.finally(() => {
    state.commands.delete(completion);
  });
}

export function runFixtureShell(
  script: string,
  fixture: WorkflowFixture,
  options: CommandOptions = {}
) {
  requireOpenFixture(fixture);
  assertNoFixtureToolCollisions(fixture);
  return runFixtureCommand(
    '/bin/bash',
    ['-e', '-o', 'pipefail', '-c', script],
    fixture,
    options
  );
}

function assertNoFixtureToolCollisions(fixture: WorkflowFixture) {
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (
        entry.isSymbolicLink() &&
        (entry.name === 'node_modules' ||
          (entry.name === '.bin' &&
            path.basename(directory) === 'node_modules'))
      ) {
        throw new Error(
          `Fixture tool directories must be owned, not linked: ${file}`
        );
      }
      if (
        path.basename(directory) === '.bin' &&
        path.basename(path.dirname(directory)) === 'node_modules' &&
        ['node', 'pnpm'].includes(entry.name)
      ) {
        throw new Error(
          `Conflicting fixture-local tool: ${file}. Remove the collision; private node/pnpm shims must retain precedence.`
        );
      }
      if (entry.isDirectory()) visit(file);
    }
  };
  visit(fixture.cwd);
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
  requireOpenFixture(fixture);
  assertNoFixtureToolCollisions(fixture);
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
  let problem: string | undefined;
  if (version.aborted) problem = 'pnpm version probe cancelled';
  else if (version.timedOut) problem = 'pnpm version probe timed out';
  else if (version.spawnError) problem = 'pnpm version probe failed to spawn';
  else if (version.error) problem = 'pnpm version probe failed during cleanup';
  else if (version.status !== 0)
    problem = 'pnpm version probe exited unsuccessfully';
  else if (version.stdout.trim() !== expectedVersion)
    problem = `Expected pnpm ${expectedVersion} from ${candidate}. Put the project's already-installed pinned pnpm on PATH; automatic downloads and switching are disabled.`;
  if (problem)
    throw new Error(
      `${problem}\nPhase: version validation\n${describeCommand(version)}`
    );
  fs.writeFileSync(
    path.join(fixture.bin, 'pnpm'),
    `#!/bin/sh\nexec ${shellQuote(candidate)} "$@"\n`,
    { mode: 0o700 }
  );
  return env;
}
