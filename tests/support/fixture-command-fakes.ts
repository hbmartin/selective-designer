import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import type { ProcessRow } from './fixture-process-snapshot.mjs';
import { FIXTURE_PROTOCOL_VERSION } from './fixture-command-protocol.mjs';
import {
  acknowledgeFixtureCleanupFailure,
  disposeFixtureCommands,
  runFixtureCommand,
  unresolvedFixtureCleanupFailures,
  type WorkflowFixture,
} from './workflow-fixtures';

export const fixtureTurn = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
export function fixtureCommandFakes(fixture: WorkflowFixture) {
  const rows = new Map<number, ProcessRow>([
    [
      process.pid,
      {
        pid: process.pid,
        parent: process.ppid,
        group: process.pid,
        state: 'S',
        started: 'runner',
      },
    ],
  ]);
  const children: FakeSupervisor[] = [];
  const commands: ReturnType<typeof runFixtureCommand>[] = [];
  let inspectionError: Error | undefined;
  let malformed = false;
  const row = (
    pid: number,
    parent: number,
    group = pid,
    started = `birth-${pid}`,
    state = 'S'
  ) => {
    const value = { pid, parent, group, started, state };
    rows.set(pid, value);
    return value;
  };
  class FakeSupervisor extends EventEmitter {
    pid: number;
    workloadPid: number;
    nonce: string;
    connected = true;
    stdout: PassThrough | null | undefined = new PassThrough();
    stderr: PassThrough | null | undefined = new PassThrough();
    channel = { unref: vi.fn() };
    unref = vi.fn();
    released = false;
    terminal = false;
    resistant = true;
    keepPipes = false;
    sent: Record<string, unknown>[] = [];
    constructor(args: readonly string[]) {
      super();
      this.pid = 2_000_001 + children.length;
      this.workloadPid = 3_000_001 + children.length;
      this.nonce = args[1]!;
      row(this.pid, process.pid);
    }
    message(message: Record<string, unknown>) {
      this.emit('message', {
        version: FIXTURE_PROTOCOL_VERSION,
        nonce: this.nonce,
        ...message,
      });
    }
    owned() {
      this.message({ type: 'owned', identity: rows.get(this.pid) });
    }
    workload() {
      this.message({
        type: 'workload',
        identity: row(this.workloadPid, this.pid, this.pid),
      });
    }
    send(
      message: Record<string, unknown>,
      callback?: (error?: Error | null) => void
    ) {
      this.sent.push(message);
      if (message.type === 'start') {
        this.released = true;
        queueMicrotask(() => this.workload());
      }
      if (message.type === 'retire' && this.terminal) {
        rows.delete(this.pid);
        void this.close(0, null);
      }
      callback?.(null);
      return true;
    }
    disconnect() {
      this.connected = false;
      if (!this.released) {
        rows.delete(this.pid);
        void this.close(0, null);
      }
    }
    targetExit(
      status: number | null = 0,
      signal: NodeJS.Signals | null = null
    ) {
      this.terminal = true;
      rows.delete(this.workloadPid);
      this.message({ type: 'target-exit', status, signal });
    }
    async close(status: number | null, signal: NodeJS.Signals | null) {
      this.emit('exit', status, signal);
      if (this.keepPipes) return;
      this.stdout?.end();
      this.stderr?.end();
      await fixtureTurn();
      this.emit('close');
    }
  }
  const inspect = vi.spyOn(childProcess, 'spawnSync').mockImplementation(() => {
    if (inspectionError) throw inspectionError;
    return {
      status: 0,
      signal: null,
      pid: 1,
      output: [],
      stderr: '',
      stdout: malformed
        ? 'invalid process row'
        : [...rows.values()]
            .map(
              (value) =>
                `${value.pid} ${value.parent} ${value.group} ${value.state} ${value.started}`
            )
            .join('\n'),
    };
  });
  const spawn = vi
    .spyOn(childProcess, 'spawn')
    .mockImplementation((_command, args) => {
      const child = new FakeSupervisor(args as string[]);
      children.push(child);
      queueMicrotask(() => child.owned());
      return child as unknown as childProcess.ChildProcess;
    });
  // A persistent replacement is mandatory: synthetic IDs must never reach the OS.
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    const child = children.find((candidate) => candidate.pid === -pid);
    if (signal === 'SIGTERM' && child && !child.resistant)
      child.targetExit(null, 'SIGTERM');
    if (signal === 'SIGKILL' || !child) {
      for (const [id, value] of rows) if (value.group === -pid) rows.delete(id);
      if (child) void child.close(null, signal as NodeJS.Signals);
    }
    return true;
  });
  syncBuiltinESMExports();
  return {
    rows,
    row,
    children,
    spawn,
    inspect,
    kill,
    failInspection(error = new Error('primary inspection fault')) {
      inspectionError = error;
    },
    recoverInspection() {
      inspectionError = undefined;
      malformed = false;
    },
    malformedInspection() {
      malformed = true;
    },
    start(options: Parameters<typeof runFixtureCommand>[3] = {}) {
      const running = runFixtureCommand(process.execPath, [], fixture, {
        terminationGraceMs: 0,
        ...options,
      });
      commands.push(running);
      return { running, child: children.at(-1)! };
    },
    async cleanup() {
      inspectionError = undefined;
      malformed = false;
      for (const [id] of rows) if (id !== process.pid) rows.delete(id);
      for (const child of children) {
        child.keepPipes = false;
        if (child.released) child.targetExit();
        await child.close(0, null);
      }
      const results = await Promise.all(commands);
      try {
        await disposeFixtureCommands(fixture);
      } catch {
        /* Exact pipe tokens are acknowledged below after synthetic absence verification. */
      }
      for (const result of results)
        for (const failure of unresolvedFixtureCleanupFailures(
          fixture,
          result.cleanupFailures
        )) {
          if (failure.kind === 'output-drain-unconfirmed')
            acknowledgeFixtureCleanupFailure(fixture, failure, {
              reason: 'Synthetic groups verified absent during test teardown',
            });
        }
    },
  };
}
