import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { runFixtureCommandSupervisor } from '@tests/support/fixture-command-supervisor.mjs';
import {
  readSupervisorMessage,
  readSupervisorControl,
} from '@tests/support/fixture-command-protocol.mjs';
import type { ProcessRow } from '@tests/support/fixture-process-snapshot.mjs';
import { expect, it, vi } from 'vitest';
const nonce = 'test-supervisor-channel';
const control = (value: Record<string, unknown>) => ({
  version: 1,
  nonce,
  ...value,
});
function setup({
  selfFailure = false,
  birthFailure = false,
  connected = true,
  targetPid = 200,
  targetZombie = false,
} = {}) {
  const sent: Record<string, unknown>[] = [];
  const ipc = Object.assign(new EventEmitter(), {
    pid: 100,
    ppid: 42,
    argv: ['node', 'supervisor', nonce],
    connected,
    send: vi.fn(
      (
        value: Record<string, unknown>,
        callback: (error?: Error | null) => void
      ) => {
        sent.push(value);
        callback(null);
        return false;
      }
    ),
    exit: vi.fn(),
  });
  const child = Object.assign(new EventEmitter(), {
    pid: targetPid as number | undefined,
  });
  const spawned = vi.fn(() => child as unknown as ChildProcess);
  const order: string[] = [];
  const inspect = vi.fn(() => {
    order.push('inspect');
    if (
      (selfFailure && inspect.mock.calls.length === 1) ||
      (birthFailure && inspect.mock.calls.length > 1)
    )
      throw new Error('inspection unavailable');
    const rows: ProcessRow[] = [
      { pid: 100, parent: 42, group: 100, state: 'S', started: 'supervisor' },
      {
        pid: 200,
        parent: 100,
        group: 100,
        state: targetZombie ? 'Z' : 'S',
        started: 'workload',
      },
    ];
    return new Map(rows.map((row) => [row.pid, row]));
  });
  spawned.mockImplementation(() => {
    order.push('spawn');
    return child as unknown as ChildProcess;
  });
  runFixtureCommandSupervisor({ ipc, spawnTarget: spawned, inspect });
  const start = () =>
    ipc.emit(
      'message',
      control({
        type: 'start',
        command: "/chosen/manager's pnpm",
        args: ['arg with spaces', '$(literal)'],
        cwd: '/missing/owned/cwd',
        env: { PATH: '/private/bin', NODE_OPTIONS: 'target-only' },
      })
    );
  return { ipc, child, spawned, inspect, sent, start, order };
}
it('establishes self ownership before workload release and captures birth without yielding', () => {
  const h = setup();
  expect(h.spawned).not.toHaveBeenCalled();
  expect(h.sent[0]).toMatchObject({
    type: 'owned',
    identity: { pid: 100, started: 'supervisor' },
  });
  h.start();
  expect(h.order).toEqual(['inspect', 'spawn', 'inspect']);
  expect(h.sent[1]).toMatchObject({
    type: 'workload',
    identity: { pid: 200, parent: 100, group: 100, started: 'workload' },
  });
  expect(h.spawned).toHaveBeenCalledWith(
    "/chosen/manager's pnpm",
    ['arg with spaces', '$(literal)'],
    {
      cwd: '/missing/owned/cwd',
      env: { PATH: '/private/bin', NODE_OPTIONS: 'target-only' },
      detached: false,
      shell: false,
      stdio: ['ignore', 'inherit', 'inherit'],
    }
  );
});
it('exits an unreleased disconnected bootstrap without spawning or inspecting', () => {
  const h = setup({ connected: false });
  expect(h.ipc.exit).toHaveBeenCalledWith(0);
  expect(h.inspect).not.toHaveBeenCalled();
  expect(h.spawned).not.toHaveBeenCalled();
});
it('ignores TERM only after release and accepts retirement only after a target terminal report', () => {
  const unreleased = setup();
  unreleased.ipc.emit('SIGTERM');
  expect(unreleased.ipc.exit).toHaveBeenCalledWith(0);
  expect(unreleased.spawned).not.toHaveBeenCalled();
  const h = setup();
  h.start();
  h.ipc.emit('SIGTERM');
  h.ipc.emit('message', control({ type: 'retire' }));
  expect(h.ipc.exit).not.toHaveBeenCalled();
  h.child.emit('exit', 23, null);
  h.ipc.emit('message', control({ type: 'retire' }));
  expect(h.sent.at(-2)).toMatchObject({
    type: 'target-exit',
    status: 23,
    signal: null,
  });
  expect(h.sent.at(-1)).toMatchObject({ type: 'retired' });
  expect(h.ipc.exit).toHaveBeenCalledWith(0);
});
it('fails the first self inspection without releasing workload or retrying', () => {
  const h = setup({ selfFailure: true });
  expect(h.inspect).toHaveBeenCalledOnce();
  expect(h.spawned).not.toHaveBeenCalled();
  expect(h.sent[0]).toMatchObject({ type: 'inspection-failed', stage: 'self' });
  expect(h.ipc.exit).toHaveBeenCalledWith(1);
});
it('retains post-release birth failure and permits later explicit retirement', () => {
  const h = setup({ birthFailure: true });
  h.start();
  expect(h.sent[1]).toMatchObject({
    type: 'inspection-failed',
    stage: 'workload',
  });
  expect(h.inspect).toHaveBeenCalledTimes(2);
  expect(h.ipc.exit).not.toHaveBeenCalled();
  h.child.emit('exit', 0, null);
  h.ipc.emit('message', control({ type: 'retire' }));
  expect(h.ipc.exit).toHaveBeenCalledWith(0);
});
it('records zombie birth evidence without turning a fast exit into a startup failure', () => {
  const h = setup({ targetZombie: true });
  h.start();
  h.child.emit('exit', 0, null);
  expect(h.sent[1]).toMatchObject({
    type: 'workload',
    identity: { state: 'Z' },
  });
  expect(h.sent[2]).toMatchObject({ type: 'target-exit', status: 0 });
});
it('preserves native error fields and does not inspect an absent target PID', () => {
  const h = setup();
  h.child.pid = undefined;
  h.start();
  h.child.emit(
    'error',
    Object.assign(new Error('spawn missing ENOENT'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'spawn missing',
      path: 'missing',
      spawnargs: ['quoted arg'],
    })
  );
  expect(h.inspect).toHaveBeenCalledOnce();
  expect(h.sent[1]).toMatchObject({
    type: 'spawn-failed',
    error: {
      message: 'spawn missing ENOENT',
      code: 'ENOENT',
      errno: -2,
      syscall: 'spawn missing',
      path: 'missing',
      spawnargs: ['quoted arg'],
    },
  });
});
it.each([
  { version: 2, nonce, type: 'retire' },
  { version: 1, nonce: 'foreign', type: 'retire' },
  {
    version: 1,
    nonce,
    type: 'start',
    command: 'node',
    args: [],
    cwd: '/',
    env: { BAD: 2 },
  },
])('rejects malformed or foreign controls before launch: %j', (message) => {
  const h = setup();
  h.ipc.emit('message', message);
  expect(h.spawned).not.toHaveBeenCalled();
  expect(h.sent.at(-1)).toMatchObject({ type: 'protocol-failed' });
});
it('protocol validation rejects invalid identity, native errors, and terminal fields', () => {
  for (const value of [
    { type: 'owned', identity: { pid: 0 } },
    { type: 'target-exit', status: null, signal: null },
    { type: 'spawn-failed', error: { message: 1 } },
  ])
    expect(readSupervisorMessage(control(value), nonce)).toBeUndefined();
  expect(
    readSupervisorControl(control({ type: 'retire' }), nonce)
  ).toMatchObject({ type: 'retire' });
});
