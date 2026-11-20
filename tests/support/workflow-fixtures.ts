import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  FIXTURE_PROTOCOL_VERSION,
  readSupervisorMessage,
  restoreFixtureError,
} from './fixture-command-protocol.mjs';
import type { ProcessRow } from './fixture-process-snapshot.mjs';
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
      failures: new Map(),
      capabilities: new Map(),
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

export type FixtureCleanupFailure = Readonly<{
  kind: 'owned-groups-unconfirmed' | 'output-drain-unconfirmed';
  error: Error;
}>;
const capabilityBrand = Symbol('fixture process group');
export type FixtureProcessGroupCapability = Readonly<{
  pid: number;
  [capabilityBrand]: true;
}>;

export type CommandResult = {
  command: string;
  cwd: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  terminationSource: 'workload' | 'supervisor' | null;
  timedOut: boolean;
  aborted: boolean;
  abortReason?: string;
  error?: Error;
  spawnError?: Error;
  cleanupError?: Error;
  readonly cleanupFailures: readonly FixtureCleanupFailure[];
  stdout: string;
  stderr: string;
};

type CleanupBudget = { termUntil: number; deadline: number };
type GroupCleanupOutcome =
  | { type: 'stopped' }
  | { type: 'unconfirmed'; error: Error };
type GroupPass = {
  completion: Promise<GroupCleanupOutcome>;
  outcome?: GroupCleanupOutcome;
  settle: (outcome: GroupCleanupOutcome) => void;
};
type OwnedGroup = FixtureProcessGroup & {
  owner: CommandControl;
  automatic: boolean;
  pass?: GroupPass;
};
type CommandControl = {
  phase: 'starting' | 'running' | 'cleaning' | 'settled';
  supervisor?: Readonly<ProcessRow>;
  workload?: Readonly<ProcessRow>;
  root?: OwnedGroup;
  startup: Promise<void>;
  startupDone: () => void;
  budget?: CleanupBudget;
  targetTerminal: boolean;
  retireRequested: boolean;
  transportError?: Error;
  inspectionFailure?: Error;
  requestRetire?: () => void;
  releaseEndpoint?: () => void;
  failure: (failure: FixtureCleanupFailure) => void;
  stop: () => void;
};
type FixtureState = {
  closing: boolean;
  disposed: boolean;
  commands: Map<Promise<CommandResult>, CommandControl>;
  groups: Set<OwnedGroup>;
  failures: Map<FixtureCleanupFailure, ReadonlySet<OwnedGroup> | undefined>;
  capabilities: Map<OwnedGroup, FixtureProcessGroupCapability>;
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

const capturedGroups = new WeakMap<
  FixtureProcessGroupCapability,
  { retired: true } | { retired: false; state: FixtureState; group: OwnedGroup }
>();

function combineErrors(previous: Error | undefined, next: Error) {
  return previous
    ? new AggregateError(
        [previous, next],
        `${previous.message}; ${next.message}`
      )
    : next;
}
function recordFailure(
  state: FixtureState,
  kind: FixtureCleanupFailure['kind'],
  error: Error,
  groups?: readonly OwnedGroup[]
) {
  const failure = Object.freeze({ kind, error });
  state.failures.set(failure, groups ? new Set(groups) : undefined);
  return failure;
}
function reconcileFailures(state: FixtureState) {
  for (const [failure, groups] of state.failures) {
    if (groups && [...groups].every((group) => !state.groups.has(group)))
      state.failures.delete(failure);
  }
}
export function acknowledgeFixtureCleanupFailure(
  fixture: WorkflowFixture,
  failure: FixtureCleanupFailure,
  { reason }: { reason: string }
): void {
  const state = fixtureState(fixture);
  if (
    !state.failures.has(failure) ||
    failure.kind !== 'output-drain-unconfirmed'
  )
    throw new Error(
      'Expected an unresolved output-drain failure from this fixture'
    );
  if (!reason.trim())
    throw new Error('Cleanup acknowledgement requires a reason');
  if (state.groups.size)
    throw new Error(
      'Owned process groups must be verified stopped before acknowledgement'
    );
  state.failures.delete(failure);
}

export function unresolvedFixtureCleanupFailures(
  fixture: WorkflowFixture,
  failures: readonly FixtureCleanupFailure[]
): readonly FixtureCleanupFailure[] {
  const state = fixtureState(fixture);
  return failures.filter((failure) => state.failures.has(failure));
}

function ownerIsLive(
  command: CommandControl,
  rows: ReadonlyMap<number, ProcessRow>
) {
  const { supervisor, workload } = command;
  if (command.phase !== 'running' || !supervisor || !workload) return false;
  const guard = rows.get(supervisor.pid);
  const target = rows.get(workload.pid);
  return (
    guard !== undefined &&
    target !== undefined &&
    !guard.state.startsWith('Z') &&
    !target.state.startsWith('Z') &&
    guard.started === supervisor.started &&
    guard.parent === supervisor.parent &&
    guard.group === supervisor.pid &&
    target.started === workload.started &&
    target.group === supervisor.pid &&
    target.parent === supervisor.pid
  );
}
async function captureGroup(
  fixture: WorkflowFixture,
  pid: number,
  automatic: boolean
): Promise<FixtureProcessGroupCapability> {
  let state = requireOpenFixture(fixture);
  let rows = inspectFixtureProcesses();
  // An already-live owner must not wait for another command's startup.
  // If birth reporting is pending, ancestry identifies the one relevant gate.
  while (true) {
    const ancestors = new Set<number>();
    let ancestor = rows.get(pid);
    while (ancestor && !ancestors.has(ancestor.pid)) {
      ancestors.add(ancestor.pid);
      ancestor = rows.get(ancestor.parent);
    }
    const pendingOwner = [...state.commands.values()].find(
      (command) =>
        command.phase === 'starting' &&
        command.root &&
        ancestors.has(command.root.pid)
    );
    if (!pendingOwner) break;
    await pendingOwner.startup;
    state = requireOpenFixture(fixture);
    rows = inspectFixtureProcesses();
  }
  const existing = [...state.groups].find((group) => group.pid === pid);
  if (existing) {
    if (!ownerIsLive(existing.owner, rows))
      throw new Error('Originating fixture command is no longer running');
    if (!fixtureGroupIsLive(existing, rows))
      throw new Error(`Fixture group ${pid} has stopped`);
    const capability = state.capabilities.get(existing);
    if (capability) {
      requireOpenFixture(fixture);
      if (automatic) existing.automatic = true;
      return capability;
    }
  }
  const active = [...state.commands.values()].filter((command) =>
    ownerIsLive(command, rows)
  );
  const identity = validateDetachedFixtureGroup(
    pid,
    new Set(active.map((command) => command.workload!.pid)),
    rows
  );
  let row = rows.get(pid);
  while (row && !active.some((command) => command.workload!.pid === row!.pid))
    row = rows.get(row.parent);
  const owner = active.find((command) => command.workload!.pid === row?.pid)!;
  const group: OwnedGroup = { ...identity, owner, automatic };
  const capability: FixtureProcessGroupCapability = Object.freeze({
    pid,
    [capabilityBrand]: true as const,
  });
  requireOpenFixture(fixture);
  capturedGroups.set(capability, { retired: false, state, group });
  state.capabilities.set(group, capability);
  state.groups.add(group);
  return capability;
}
export function captureFixtureProcessGroup(
  fixture: WorkflowFixture,
  pid: number
) {
  return captureGroup(fixture, pid, false);
}
export async function registerFixtureProcessGroup(
  fixture: WorkflowFixture,
  pid: number
): Promise<void> {
  await captureGroup(fixture, pid, true);
}
export async function disposeCapturedFixtureProcessGroup(
  capability: FixtureProcessGroupCapability
): Promise<void> {
  const captured = capturedGroups.get(capability);
  if (!captured) throw new Error('Unknown fixture process-group capability');
  if (captured.retired) return;
  if (captured.state.groups.has(captured.group))
    await stopGroups(captured.state, [captured.group]);
  reconcileFailures(captured.state);
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
function retireGroup(state: FixtureState, group: OwnedGroup) {
  state.groups.delete(group);
  const capability = state.capabilities.get(group);
  if (capability) capturedGroups.set(capability, { retired: true });
  state.capabilities.delete(group);
  reconcileFailures(state);
  if (group.owner.root === group && group.owner.phase === 'settled')
    group.owner.releaseEndpoint?.();
}
function failGroup(state: FixtureState, group: OwnedGroup, error: Error) {
  const failure = recordFailure(state, 'owned-groups-unconfirmed', error, [
    group,
  ]);
  group.owner.failure(failure);
  return error;
}
async function runGroupPass(
  state: FixtureState,
  passes: ReadonlyMap<OwnedGroup, GroupPass>,
  budget: CleanupBudget,
  priorFailures: ReadonlyMap<CommandControl, Error | undefined>
) {
  let remaining = [...passes.keys()];
  const complete = (group: OwnedGroup, outcome: GroupCleanupOutcome) => {
    const pass = passes.get(group)!;
    if (group.pass === pass) group.pass = undefined;
    pass.settle(outcome);
  };
  const unconfirmed = (group: OwnedGroup, error: Error) =>
    complete(group, {
      type: 'unconfirmed',
      error: failGroup(state, group, error),
    });
  const terminated = new Set<OwnedGroup>();
  const killed = new Set<OwnedGroup>();
  const noNewInspectionFailure = (group: OwnedGroup) => {
    const failure = group.owner.inspectionFailure;
    if (!failure || priorFailures.get(group.owner) === failure) return true;
    unconfirmed(group, failure);
    return false;
  };
  while (remaining.length) {
    remaining = remaining.filter((group) => {
      if (state.groups.has(group)) return true;
      complete(group, { type: 'stopped' });
      return false;
    });
    remaining = remaining.filter(noNewInspectionFailure);
    if (!remaining.length) break;
    const left = budget.deadline - performance.now();
    if (left < 100) {
      for (const group of remaining)
        unconfirmed(
          group,
          new Error(`Fixture cleanup deadline expired for group ${group.pid}`)
        );
      break;
    }
    let rows: ReturnType<typeof inspectFixtureProcesses>;
    try {
      rows = inspectFixtureProcesses(left);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      for (const group of remaining) unconfirmed(group, error);
      break; // A failed whole snapshot authorizes no signaling or retry.
    }
    remaining = remaining.filter((group) => {
      if (!noNewInspectionFailure(group)) return false;
      try {
        if (!fixtureGroupIsLive(group, rows)) {
          retireGroup(state, group);
          complete(group, { type: 'stopped' });
          return false;
        }
        const guardOnly =
          group.owner.root === group &&
          group.owner.targetTerminal &&
          [...rows.values()]
            .filter(
              (row) => row.group === group.pid && !row.state.startsWith('Z')
            )
            .every((row) => row.pid === group.pid);
        if (
          guardOnly &&
          !group.owner.transportError &&
          !group.owner.retireRequested
        ) {
          group.owner.requestRetire?.();
        } else if (performance.now() >= budget.termUntil) {
          if (!killed.has(group)) {
            signalFixtureGroup(group, 'SIGKILL', rows);
            killed.add(group);
          }
        } else if (
          !(group.owner.root === group && group.owner.retireRequested) &&
          !terminated.has(group)
        ) {
          signalFixtureGroup(group, 'SIGTERM', rows);
          terminated.add(group);
        }
        return true;
      } catch (cause) {
        unconfirmed(
          group,
          cause instanceof Error ? cause : new Error(String(cause))
        );
        return false; // This group's uncertainty cannot strand verified siblings.
      }
    });
    if (!remaining.length) break;
    const toTerm = budget.termUntil - performance.now();
    await pause(
      toTerm > 0 && toTerm < 500
        ? toTerm
        : Math.min(50, Math.max(0, budget.deadline - performance.now() - 100))
    );
  }
}
async function stopGroups(
  state: FixtureState,
  groups: OwnedGroup[],
  explicitBudget?: CleanupBudget
) {
  const passes = new Map<OwnedGroup, GroupPass>();
  const batches = new Map<CleanupBudget, OwnedGroup[]>();
  const fresh = {
    termUntil: performance.now() + 2_000,
    deadline: performance.now() + 3_000,
  };
  for (const group of groups) {
    if (!state.groups.has(group)) continue;
    if (group.pass) {
      passes.set(group, group.pass);
      continue;
    }
    const budget =
      explicitBudget ??
      (group.owner.phase === 'cleaning' ? group.owner.budget : undefined) ??
      fresh;
    const batch = batches.get(budget) ?? [];
    batch.push(group);
    batches.set(budget, batch);
  }
  for (const [budget, batch] of batches) {
    const priorFailures = new Map(
      batch.map((group) => [group.owner, group.owner.inspectionFailure])
    );
    const batchPasses = new Map<OwnedGroup, GroupPass>();
    for (const group of batch) {
      let resolve!: (outcome: GroupCleanupOutcome) => void;
      const completion = new Promise<GroupCleanupOutcome>((done) => {
        resolve = done;
      });
      const pass: GroupPass = {
        completion,
        settle(outcome) {
          if (pass.outcome) return;
          pass.outcome = outcome;
          resolve(outcome);
        },
      };
      group.pass = pass;
      batchPasses.set(group, pass);
      passes.set(group, pass);
    }
    // Install every lock before shared inspection or reentrant synthetic events.
    void Promise.resolve()
      .then(() => runGroupPass(state, batchPasses, budget, priorFailures))
      .catch((cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        for (const [group, pass] of batchPasses) {
          if (pass.outcome) continue;
          if (group.pass === pass) group.pass = undefined;
          pass.settle({
            type: 'unconfirmed',
            error: failGroup(state, group, error),
          });
        }
      });
  }
  const completion = Promise.all(
    [...passes.values()].map((pass) => pass.completion)
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (explicitBudget) {
      await Promise.race([
        completion,
        new Promise<void>((resolve) => {
          timer = setTimeout(
            resolve,
            Math.max(0, explicitBudget.deadline - performance.now())
          );
        }),
      ]);
    } else {
      await completion;
    }
  } finally {
    clearTimeout(timer);
  }
  const errors: Error[] = [];
  for (const [group, pass] of passes) {
    if (!pass.outcome) {
      // Bound this caller without changing the shared pass's schedule or lock.
      errors.push(
        failGroup(
          state,
          group,
          new Error(
            `Fixture cleanup deadline expired while waiting for group ${group.pid}`
          )
        )
      );
    } else if (pass.outcome.type === 'unconfirmed') {
      errors.push(pass.outcome.error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Fixture process cleanup failed');
}

export async function disposeFixtureCommands(fixture: WorkflowFixture) {
  const state = fixtureState(fixture);
  state.closing = true;
  const failedAtEntry = new Set(
    [...state.failures.values()].flatMap((groups) =>
      groups ? [...groups] : []
    )
  );
  const retryGroups = [...state.groups].filter(
    (group) =>
      group.owner.phase === 'settled' ||
      !group.automatic ||
      failedAtEntry.has(group)
  );
  for (const command of state.commands.values()) command.stop();
  // Recover previously failed passes while output can still reach EOF.
  const results = await Promise.allSettled([
    stopGroups(state, retryGroups),
    ...state.commands.keys(),
  ]);
  reconcileFailures(state);
  const errors = [
    ...results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    ),
    ...[...state.failures.keys()].map((failure) => failure.error),
  ];
  if (errors.length)
    throw new AggregateError(
      errors,
      `Fixture cleanup remains unresolved: ${fixture.root}`
    );
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
      pending.map(async (fixture) => disposeWorkflowFixture(fixture))
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
    `Termination source: ${result.terminationSource ?? 'none'}`,
    `Cancellation: ${result.abortReason ?? 'none'}`,
    `Error: ${result.error?.message ?? 'none'}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join('\n');
}

const supervisorFile = fileURLToPath(
  new URL('./fixture-command-supervisor.mjs', import.meta.url)
);
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
  const startedAt = performance.now();
  const commandArgs = [...args];
  const environmentEntries: [string, string][] = [];
  for (const key in env) {
    const value = env[key];
    if (value !== undefined) environmentEntries.push([key, value]);
  }
  const commandEnv = Object.fromEntries(environmentEntries);
  cwd = path.resolve(cwd);
  const failures: FixtureCleanupFailure[] = [];
  const result: CommandResult = {
    command: [command, ...commandArgs].join(' '),
    cwd,
    status: null,
    signal: null,
    terminationSource: null,
    timedOut: false,
    aborted: signal?.aborted ?? false,
    cleanupFailures: failures,
    stdout: '',
    stderr: '',
  };
  if (signal?.aborted) {
    result.abortReason = String(signal.reason);
    Object.freeze(failures);
    return Promise.resolve(result);
  }
  const state = requireOpenFixture(fixture);
  assertOwnedWorkingDirectory(fixture, cwd);
  assertNoFixtureToolCollisions(fixture);
  let ready = () => {};
  const startup = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const control: CommandControl = {
    phase: 'starting',
    startup,
    startupDone: ready,
    targetTerminal: false,
    retireRequested: false,
    failure: () => {},
    stop: () => {},
  };
  const nonce = randomUUID();
  const completion = new Promise<CommandResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [supervisorFile, nonce], {
        cwd: fixture.root,
        env: fixtureEnvironment(fixture),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (cause) {
      result.spawnError =
        cause instanceof Error ? cause : new Error(String(cause));
      result.error = result.spawnError;
      control.phase = 'settled';
      ready();
      Object.freeze(failures);
      resolve(result);
      return;
    }
    if (child.pid !== undefined) {
      const root: OwnedGroup = {
        pid: child.pid,
        owner: control,
        automatic: true,
      };
      control.root = root;
      state.groups.add(root);
    }
    let settled = false;
    let closed = false;
    let supervisorExited = false;
    let releaseIssued = false;
    let cleanup: Promise<void> | undefined;
    let executionTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let onClose = () => {};
    const reconciled = new Set<unknown>();
    const addError = (error: Error) => {
      if (result.error !== error)
        result.error = combineErrors(result.error, error);
    };
    control.failure = (failure) => {
      if (settled) return;
      failures.push(failure);
      if (result.cleanupError !== failure.error)
        result.cleanupError = combineErrors(result.cleanupError, failure.error);
      addError(failure.error);
    };
    const detach = () => {
      child.removeAllListeners('message');
      child.removeAllListeners('exit');
      child.removeAllListeners('close');
      if (child.connected) child.disconnect();
      child.unref();
      child.channel?.unref();
    };
    control.releaseEndpoint = detach;
    const send = (message: Record<string, unknown>) => {
      if (!child.connected)
        throw new Error('Fixture supervisor IPC is disconnected');
      child.send(
        { version: FIXTURE_PROTOCOL_VERSION, nonce, ...message },
        (error) => {
          if (!error) return;
          control.transportError = error;
          control.retireRequested = false;
          if (!settled) {
            addError(error);
            beginCleanup();
          }
        }
      );
    };
    control.requestRetire = () => {
      control.retireRequested = true;
      try {
        send({ type: 'retire' });
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        control.transportError = error;
        control.retireRequested = false;
        if (!settled) addError(error);
      }
    };
    const reconcilePipes = () => {
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream || stream.readableEnded || reconciled.has(stream)) continue;
        reconciled.add(stream);
        const error = new Error(
          'Fixture output closure could not be confirmed; unregistered daemonization is unsupported'
        );
        control.failure(
          recordFailure(state, 'output-drain-unconfirmed', error)
        );
        if (!stream.destroyed) {
          try {
            stream.destroy();
          } catch (cause) {
            addError(cause instanceof Error ? cause : new Error(String(cause)));
          }
        }
      }
    };
    const finish = () => {
      if (settled) return;
      if (
        supervisorExited &&
        !control.targetTerminal &&
        !result.aborted &&
        !result.timedOut &&
        !result.error
      )
        addError(
          new Error('Fixture supervisor exited before reporting its workload')
        );
      reconcilePipes();
      settled = true;
      control.phase = 'settled';
      ready();
      clearTimeout(executionTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.unref();
      child.channel?.unref();
      if (!control.root || !state.groups.has(control.root)) detach();
      Object.freeze(failures);
      resolve(result);
    };
    const beginCleanup = (inspectionFailure?: Error) => {
      if (control.phase === 'settled') return;
      if (inspectionFailure) control.inspectionFailure = inspectionFailure;
      if (control.phase === 'cleaning') {
        if (inspectionFailure)
          for (const group of state.groups)
            if (group.owner === control && group.automatic && !group.pass)
              failGroup(state, group, inspectionFailure);
        return;
      }
      control.phase = 'cleaning';
      ready();
      clearTimeout(executionTimer);
      const now = performance.now();
      control.budget = {
        termUntil: now + terminationGraceMs,
        deadline: now + terminationGraceMs + 1_000,
      };
      if (!releaseIssued && child.connected) child.disconnect();
      const groups = [...state.groups].filter(
        (group) => group.owner === control && group.automatic
      );
      cleanup = (async () => {
        if (!releaseIssued && !closed && !inspectionFailure)
          await new Promise<void>((drained) => {
            onClose = drained;
            drainTimer = setTimeout(
              drained,
              Math.max(0, control.budget!.deadline - performance.now())
            );
          });
        if (inspectionFailure) {
          for (const group of groups)
            failGroup(state, group, inspectionFailure);
        } else {
          try {
            await stopGroups(state, groups, control.budget);
          } catch {
            /* Exact ledger failures are captured on the command. */
          }
        }
        clearTimeout(drainTimer);
        if (!closed)
          await new Promise<void>((drained) => {
            onClose = drained;
            drainTimer = setTimeout(
              drained,
              Math.max(0, control.budget!.deadline - performance.now())
            );
          });
        finish();
      })();
      void cleanup.catch((cause) => {
        addError(cause instanceof Error ? cause : new Error(String(cause)));
        finish();
      });
    };
    const stop = (reason: 'aborted' | 'timedOut', detail?: string) => {
      if (control.phase !== 'starting' && control.phase !== 'running') return;
      result[reason] = true;
      result.abortReason = detail;
      beginCleanup();
    };
    const onAbort = () => stop('aborted', String(signal?.reason));
    control.stop = () => stop('aborted', 'Fixture disposed');
    // Error must be handled before any potentially absent stdio access.
    child.on('error', (error) => {
      if (settled) return;
      result.spawnError = error;
      addError(error);
      beginCleanup();
    });
    child.on('message', (value) => {
      const message = readSupervisorMessage(value, nonce);
      if (!message) {
        if (!settled) {
          const error = new Error('Invalid fixture supervisor message');
          addError(error);
          beginCleanup(error);
        }
        return;
      }
      if (message.type === 'target-exit') {
        if (!releaseIssued || !control.supervisor) {
          if (!settled) {
            const error = new Error('Workload result before release');
            addError(error);
            beginCleanup(error);
          }
          return;
        }
        if (control.targetTerminal) return;
        control.targetTerminal = true;
        if (!settled) {
          result.status = message.status;
          result.signal = message.signal;
          result.terminationSource = 'workload';
          beginCleanup();
        }
        return;
      }
      if (message.type === 'spawn-failed') {
        if (!releaseIssued || !control.supervisor) {
          if (!settled) {
            const error = new Error('Workload spawn failure before release');
            addError(error);
            beginCleanup(error);
          }
          return;
        }
        if (control.targetTerminal) return;
        control.targetTerminal = true;
        if (!settled) {
          result.spawnError = restoreFixtureError(message.error);
          addError(result.spawnError);
          beginCleanup();
        }
        return;
      }
      if (settled) return;
      if (message.type === 'owned') {
        if (control.phase === 'cleaning' && !releaseIssued) return;
        if (
          control.phase !== 'starting' ||
          control.supervisor ||
          !control.root ||
          message.identity.pid !== child.pid ||
          message.identity.group !== child.pid ||
          message.identity.parent !== process.pid ||
          message.identity.state.startsWith('Z')
        ) {
          const error = new Error(
            'Invalid original fixture supervisor identity'
          );
          addError(error);
          beginCleanup(error);
          return;
        }
        control.supervisor = Object.freeze({ ...message.identity });
        Object.assign(control.root, {
          started: message.identity.started,
          members: new Map([[message.identity.pid, message.identity.started]]),
          continuity: 'authenticated',
        });
        releaseIssued = true;
        try {
          send({
            type: 'start',
            command,
            args: commandArgs,
            cwd,
            env: commandEnv,
          });
        } catch (cause) {
          const error =
            cause instanceof Error ? cause : new Error(String(cause));
          control.transportError = error;
          addError(error);
          beginCleanup();
        }
      } else if (message.type === 'workload') {
        if (
          !releaseIssued ||
          !control.supervisor ||
          control.workload ||
          message.identity.parent !== control.supervisor.pid ||
          message.identity.group !== control.supervisor.pid
        ) {
          const error = new Error('Invalid original fixture workload identity');
          addError(error);
          beginCleanup(error);
          return;
        }
        control.workload = Object.freeze({ ...message.identity });
        if (control.phase === 'starting') control.phase = 'running';
        ready();
      } else if (
        message.type === 'inspection-failed' ||
        message.type === 'protocol-failed'
      ) {
        const validPhase =
          message.type === 'protocol-failed' ||
          (message.stage === 'self'
            ? !releaseIssued && !control.supervisor
            : releaseIssued && !!control.supervisor && !control.workload);
        const error = validPhase
          ? restoreFixtureError(message.error)
          : new Error('Fixture inspection failure in the wrong startup phase');
        addError(error);
        beginCleanup(error);
      } else if (!control.retireRequested) {
        const error = new Error('Unexpected fixture supervisor retirement');
        addError(error);
        beginCleanup(error);
      }
    });
    child.on('exit', (_status, exitSignal) => {
      if (settled) return;
      supervisorExited = true;
      if (!control.targetTerminal && exitSignal !== null) {
        result.status = null;
        result.signal = exitSignal;
        result.terminationSource = 'supervisor';
      }
      beginCleanup();
    });
    child.on('close', () => {
      closed = true;
      onClose();
    });
    for (const [stream, field] of [
      [child.stdout, 'stdout'],
      [child.stderr, 'stderr'],
    ] as const) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        if (!settled) result[field] = (result[field] + chunk).slice(-1_048_576);
      });
    }
    executionTimer = setTimeout(
      () => stop('timedOut'),
      Math.max(0, timeoutMs - (performance.now() - startedAt))
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
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
  return runFixtureCommand(
    '/bin/bash',
    ['-e', '-o', 'pipefail', '-c', script],
    fixture,
    options
  );
}

function assertOwnedWorkingDirectory(fixture: WorkflowFixture, cwd: string) {
  const target = path.resolve(cwd);
  const relative = path.relative(fixture.root, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Fixture working directory must be owned: ${cwd}`);
  }
  let current = fixture.root;
  if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`Fixture root cannot be a symlink: ${current}`);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break; // Preserve spawn's ENOENT for missing owned paths.
    if (stat.isSymbolicLink())
      throw new Error(
        `Fixture working directory cannot traverse a symlink: ${current}`
      );
  }
}

function assertNoFixtureToolCollisions(fixture: WorkflowFixture) {
  const visit = (directory: string) => {
    // Canonical lookups let the filesystem decide case sensitivity.
    const modules = path.join(directory, 'node_modules');
    const modulesStat = fs.lstatSync(modules, { throwIfNoEntry: false });
    if (modulesStat?.isSymbolicLink())
      throw new Error(
        `Fixture tool directories must be owned, not linked: ${modules}`
      );
    if (modulesStat?.isDirectory()) {
      const bin = path.join(modules, '.bin');
      const binStat = fs.lstatSync(bin, { throwIfNoEntry: false });
      if (binStat?.isSymbolicLink())
        throw new Error(
          `Fixture tool directories must be owned, not linked: ${bin}`
        );
      if (binStat?.isDirectory())
        for (const tool of ['node', 'pnpm']) {
          const collision = path.join(bin, tool);
          if (fs.lstatSync(collision, { throwIfNoEntry: false }))
            throw new Error(
              `Conflicting fixture-local tool: ${collision}. Remove the collision; private node/pnpm shims must retain precedence.`
            );
        }
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  if (fs.existsSync(fixture.root)) visit(fixture.root);
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
