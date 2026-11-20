import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import {
  fixtureCommandFakes,
  fixtureTurn,
} from '@tests/support/fixture-command-fakes';
import {
  acknowledgeFixtureCleanupFailure,
  captureFixtureProcessGroup,
  createWorkflowFixture,
  disposeCapturedFixtureProcessGroup,
  disposeFixtureCommands,
  disposeWorkflowFixture,
  disposeWorkflowFixtures,
  registerFixtureProcessGroup,
  runFixtureCommand,
  unresolvedFixtureCleanupFailures,
  type WorkflowFixture,
} from '@tests/support/workflow-fixtures';

const fixtures: WorkflowFixture[] = [];
const harnesses: ReturnType<typeof fixtureCommandFakes>[] = [];
function setup() {
  const fixture = createWorkflowFixture();
  fixtures.push(fixture);
  const fake = fixtureCommandFakes(fixture);
  harnesses.push(fake);
  return { fixture, fake };
}
afterEach(async () => {
  try {
    for (const harness of harnesses.splice(0)) await harness.cleanup();
    await disposeWorkflowFixtures(fixtures);
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  }
});

it.each(['EMFILE', 'ENFILE'])(
  'normalizes synchronous %s without inspection or signaling',
  async (code) => {
    const { fixture, fake } = setup();
    const failure = Object.assign(new Error(`spawn ${code}`), { code });
    fake.spawn.mockImplementation(() => {
      throw failure;
    });
    const result = await runFixtureCommand(process.execPath, [], fixture);
    expect(result).toMatchObject({
      spawnError: failure,
      error: failure,
      cleanupFailures: [],
    });
    expect(fake.inspect).not.toHaveBeenCalled();
    expect(fake.kill).not.toHaveBeenCalled();
  }
);
it.each([null, undefined])(
  'handles absent %s stdio and PID before async spawn failure',
  async (streams) => {
    const { fixture, fake } = setup();
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout: streams,
      stderr: streams,
      connected: false,
      unref: vi.fn(),
    });
    fake.spawn.mockReturnValue(child as unknown as childProcess.ChildProcess);
    const running = runFixtureCommand(process.execPath, [], fixture);
    const error = Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' });
    child.emit('error', error);
    child.emit('close');
    const result = await running;
    expect(result.spawnError).toBe(error);
    expect(result.cleanupFailures).toEqual([]);
    expect(fake.inspect).not.toHaveBeenCalled();
    expect(fake.kill).not.toHaveBeenCalled();
  }
);
it('keeps a failed group obligation after command settlement and recovers only on fresh proof', async () => {
  const { fixture, fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  fake.failInspection();
  command.child.targetExit();
  await command.child.close(0, null);
  const result = await command.running;
  const error = result.error;
  expect(result.cleanupFailures.map((failure) => failure.kind)).toEqual([
    'owned-groups-unconfirmed',
  ]);
  await expect(disposeWorkflowFixture(fixture)).rejects.toThrow('retained');
  expect(fs.existsSync(fixture.root)).toBe(true);
  expect(() =>
    acknowledgeFixtureCleanupFailure(fixture, result.cleanupFailures[0]!, {
      reason: 'cannot bypass identity',
    })
  ).toThrow('output-drain');
  fake.recoverInspection();
  await disposeWorkflowFixture(fixture);
  expect(result.error).toBe(error);
  expect(Object.isFrozen(result.cleanupFailures)).toBe(true);
});
it('retains separate pipe tokens and immutable primary errors through explicit acknowledgement', async () => {
  const { fixture, fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  command.child.keepPipes = true;
  fake.failInspection();
  command.child.targetExit();
  const result = await command.running;
  const error = result.error;
  expect(result.cleanupError?.message).toMatch(
    /primary inspection fault.*output closure/s
  );
  const tokens = result.cleanupFailures.filter(
    (failure) => failure.kind === 'output-drain-unconfirmed'
  );
  expect(tokens).toHaveLength(2);
  expect(() =>
    acknowledgeFixtureCleanupFailure(fixture, tokens[0]!, {
      reason: 'too early',
    })
  ).toThrow('verified stopped');
  fake.recoverInspection();
  command.child.keepPipes = false;
  await expect(disposeFixtureCommands(fixture)).rejects.toThrow('unresolved');
  expect(() =>
    acknowledgeFixtureCleanupFailure(
      fixture,
      { ...tokens[0]! },
      { reason: 'fabricated' }
    )
  ).toThrow('output-drain');
  expect(() =>
    acknowledgeFixtureCleanupFailure(fixture, result.cleanupFailures[0]!, {
      reason: 'owned group',
    })
  ).toThrow('output-drain');
  const other = createWorkflowFixture();
  fixtures.push(other);
  expect(unresolvedFixtureCleanupFailures(other, tokens)).toEqual([]);
  expect(
    unresolvedFixtureCleanupFailures(fixture, [...tokens, { ...tokens[0]! }])
  ).toEqual(tokens);
  expect(() =>
    acknowledgeFixtureCleanupFailure(other, tokens[0]!, { reason: 'foreign' })
  ).toThrow('output-drain');
  expect(() =>
    acknowledgeFixtureCleanupFailure(fixture, tokens[0]!, { reason: ' ' })
  ).toThrow('reason');
  acknowledgeFixtureCleanupFailure(fixture, tokens[0]!, {
    reason: 'Known groups stopped; first lost output accepted',
  });
  await expect(disposeWorkflowFixture(fixture)).rejects.toThrow('retained');
  expect(() =>
    acknowledgeFixtureCleanupFailure(fixture, tokens[0]!, {
      reason: 'resolved',
    })
  ).toThrow('output-drain');
  acknowledgeFixtureCleanupFailure(fixture, tokens[1]!, {
    reason: 'Second lost pipe acknowledged',
  });
  await disposeWorkflowFixture(fixture);
  expect(result.error).toBe(error);
  expect(result.cleanupFailures).toHaveLength(3);
});
it.each(['before close', 'during drain'] as const)(
  'records missing stdout EOF %s exactly once',
  async (mode) => {
    const { fixture, fake } = setup();
    const command = fake.start();
    await fixtureTurn();
    command.child.stdout!.destroy();
    command.child.stderr!.end();
    await fixtureTurn();
    if (mode === 'before close') command.child.emit('close');
    command.child.targetExit();
    if (mode === 'during drain') {
      await fixtureTurn();
      command.child.emit('close');
    }
    const result = await command.running;
    expect(
      result.cleanupFailures.filter(
        (failure) => failure.kind === 'output-drain-unconfirmed'
      )
    ).toHaveLength(1);
    await expect(disposeWorkflowFixture(fixture)).rejects.toThrow('retained');
  }
);
it('explicit disposal recovers a completed failed pass before its pipes are destroyed', async () => {
  const { fixture, fake } = setup();
  const command = fake.start({ terminationGraceMs: 100 });
  await fixtureTurn();
  fake.failInspection();
  command.child.targetExit();
  await fixtureTurn();
  expect(fake.inspect).toHaveBeenCalledOnce();
  fake.recoverInspection();
  await disposeFixtureCommands(fixture);
  const result = await command.running;
  expect(result.cleanupFailures.map((failure) => failure.kind)).toEqual([
    'owned-groups-unconfirmed',
  ]);
  expect(
    unresolvedFixtureCleanupFailures(fixture, result.cleanupFailures)
  ).toEqual([]);
  expect(result.error?.message).toContain('primary inspection fault');
});
it('joins concurrent root and capability disposal instead of duplicating group signals', async () => {
  const { fixture, fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  fake.row(4_000_001, command.child.workloadPid);
  const cap = await captureFixtureProcessGroup(fixture, 4_000_001);
  await registerFixtureProcessGroup(fixture, 4_000_001);
  await Promise.all([
    disposeCapturedFixtureProcessGroup(cap),
    disposeFixtureCommands(fixture),
  ]);
  expect(
    fake.kill.mock.calls.filter(([pid]) => pid === -4_000_001)
  ).toHaveLength(1);
});
it.each(['missing', 'zombie', 'replaced'] as const)(
  'rejects a cached capture with %s actual workload owner',
  async (mode) => {
    const { fixture, fake } = setup();
    const command = fake.start();
    await fixtureTurn();
    fake.row(4_000_001, command.child.workloadPid);
    await captureFixtureProcessGroup(fixture, 4_000_001);
    if (mode === 'missing') fake.rows.delete(command.child.workloadPid);
    if (mode === 'zombie')
      fake.rows.get(command.child.workloadPid)!.state = 'Z';
    if (mode === 'replaced')
      fake.rows.get(command.child.workloadPid)!.started = 'replacement';
    await expect(
      registerFixtureProcessGroup(fixture, 4_000_001)
    ).rejects.toThrow('no longer running');
    expect(fake.kill).not.toHaveBeenCalled();
  }
);
it('isolates group identity uncertainty while stopping independently verified groups', async () => {
  const { fixture, fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  fake.row(4_000_001, command.child.workloadPid);
  fake.row(4_000_002, command.child.workloadPid);
  const unknown = await captureFixtureProcessGroup(fixture, 4_000_001);
  const known = await captureFixtureProcessGroup(fixture, 4_000_002);
  fake.rows.delete(4_000_001);
  fake.row(4_000_003, 1, 4_000_001, 'unrelated');
  await expect(disposeFixtureCommands(fixture)).rejects.toThrow('unresolved');
  expect(fake.kill.mock.calls.some(([pid]) => pid === -4_000_002)).toBe(true);
  expect(fake.kill.mock.calls.some(([pid]) => pid === -4_000_001)).toBe(false);
  await disposeCapturedFixtureProcessGroup(known);
  await expect(disposeCapturedFixtureProcessGroup(unknown)).rejects.toThrow();
});
it('a malformed whole snapshot prevents signals to every group without retry', async () => {
  const { fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  fake.malformedInspection();
  command.child.targetExit();
  await command.child.close(0, null);
  await command.running;
  expect(fake.inspect).toHaveBeenCalledOnce();
  expect(fake.kill).not.toHaveBeenCalled();
});
it('preserves workload results and labels only observed supervisor fallback signals', async () => {
  const { fake } = setup();
  const success = fake.start();
  await fixtureTurn();
  success.child.targetExit(23);
  const observed = await success.running;
  expect(observed).toMatchObject({
    status: 23,
    signal: null,
    terminationSource: 'workload',
  });
  const cancel = new AbortController();
  const forced = fake.start({ signal: cancel.signal });
  await fixtureTurn();
  cancel.abort();
  const fallback = await forced.running;
  expect(fallback).toMatchObject({
    status: null,
    signal: 'SIGKILL',
    terminationSource: 'supervisor',
    aborted: true,
  });
  forced.child.message({ type: 'target-exit', status: 9, signal: null });
  expect(fallback.status).toBeNull();
});
it('retires an otherwise empty supervisor without TERM or a grace wait', async () => {
  const { fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  command.child.targetExit();
  const result = await command.running;
  expect(command.child.sent.map((message) => message.type)).toEqual([
    'start',
    'retire',
  ]);
  expect(fake.kill).not.toHaveBeenCalled();
  expect(result).toMatchObject({ status: 0, cleanupFailures: [] });
});
it('uses a late spawn-failure report only for recovery without changing the returned result', async () => {
  const { fixture, fake } = setup();
  const command = fake.start({ terminationGraceMs: 0 });
  await fixtureTurn();
  fake.failInspection();
  command.child.message({
    type: 'inspection-failed',
    stage: 'self',
    error: { name: 'Error', message: 'invalid phase' },
  });
  await command.child.close(0, null);
  const result = await command.running;
  const historical = { ...result };
  fake.rows.delete(command.child.workloadPid);
  command.child.terminal = true;
  command.child.message({
    type: 'spawn-failed',
    error: { name: 'Error', message: 'late native failure', code: 'ENOENT' },
  });
  fake.recoverInspection();
  await disposeFixtureCommands(fixture);
  expect(command.child.sent.at(-1)?.type).toBe('retire');
  expect(fake.kill).not.toHaveBeenCalled();
  expect(result).toEqual(historical);
});
it('cancels an unreleased supervisor without launching the workload', async () => {
  const { fake } = setup();
  const cancel = new AbortController();
  const command = fake.start({ signal: cancel.signal });
  command.child.owned = vi.fn();
  cancel.abort('cancel before ownership');
  const result = await command.running;
  expect(result).toMatchObject({
    aborted: true,
    abortReason: 'cancel before ownership',
    terminationSource: null,
    cleanupFailures: [],
  });
  expect(command.child.sent).toEqual([]);
  expect(fake.kill).not.toHaveBeenCalled();
});
it('retains permission uncertainty when the IPC send reports backpressure', async () => {
  const { fake } = setup();
  const cancel = new AbortController();
  const command = fake.start({ signal: cancel.signal });
  const send = command.child.send.bind(command.child);
  vi.spyOn(command.child, 'send').mockImplementation((message, callback) => {
    send(message, callback);
    if (message.type === 'start') cancel.abort('release may have arrived');
    return false;
  });
  const result = await command.running;
  expect(command.child.released).toBe(true);
  expect(fake.inspect).toHaveBeenCalled();
  expect(result).toMatchObject({
    aborted: true,
    terminationSource: 'supervisor',
    signal: 'SIGKILL',
    cleanupFailures: [],
  });
});
it('isolates a cooperative workload result from subsequent supervisor shutdown', async () => {
  const { fake } = setup();
  const cancel = new AbortController();
  const command = fake.start({
    signal: cancel.signal,
    terminationGraceMs: 100,
  });
  await fixtureTurn();
  command.child.resistant = false;
  cancel.abort();
  expect(await command.running).toMatchObject({
    status: null,
    signal: 'SIGTERM',
    terminationSource: 'workload',
    cleanupFailures: [],
  });
  expect(fake.kill.mock.calls.map(([, signal]) => signal)).toEqual(['SIGTERM']);
});
it('rejects an inspection report from the wrong startup phase without another snapshot', async () => {
  const { fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  command.child.message({
    type: 'inspection-failed',
    stage: 'self',
    error: { name: 'Error', message: 'impossible self report' },
  });
  await command.child.close(0, null);
  const result = await command.running;
  expect(result.error?.message).toContain('wrong startup phase');
  expect(fake.inspect).not.toHaveBeenCalled();
  expect(fake.kill).not.toHaveBeenCalled();
});
it('stops an active cleanup pass when workload birth inspection fails during cancellation', async () => {
  const { fake } = setup();
  const cancel = new AbortController();
  const command = fake.start({ signal: cancel.signal });
  command.child.workload = vi.fn();
  await fixtureTurn();
  const inspect = fake.inspect.getMockImplementation()!;
  fake.inspect.mockImplementationOnce((...args) => {
    command.child.message({
      type: 'inspection-failed',
      stage: 'workload',
      error: { name: 'Error', message: 'birth inspection failed' },
    });
    return inspect(...args);
  });
  cancel.abort();
  await command.child.close(null, null);
  const result = await command.running;
  expect(result.error?.message).toContain('birth inspection failed');
  expect(result.cleanupFailures.map((failure) => failure.kind)).toEqual([
    'owned-groups-unconfirmed',
  ]);
  expect(fake.inspect).toHaveBeenCalledOnce();
  expect(fake.kill).not.toHaveBeenCalled();
});
it('does not release or inspect a malformed startup identity again automatically', async () => {
  const { fixture, fake } = setup();
  fake.spawn.mockImplementation((_file, args) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 2_000_100,
      connected: true,
      stdout: null,
      stderr: null,
      unref() {},
      disconnect() {
        this.connected = false;
        queueMicrotask(() => child.emit('close'));
      },
    });
    queueMicrotask(() =>
      child.emit('message', {
        version: 1,
        nonce: (args as string[])[1],
        type: 'owned',
        identity: {
          pid: 2_000_101,
          parent: process.pid,
          group: 2_000_101,
          state: 'S',
          started: 'bad',
        },
      })
    );
    return child as unknown as childProcess.ChildProcess;
  });
  const result = await runFixtureCommand(process.execPath, [], fixture);
  expect(result.error?.message).toContain('Invalid original');
  expect(fake.inspect).not.toHaveBeenCalled();
  expect(fake.kill).not.toHaveBeenCalled();
});

it.each(['exit-first', 'report-first'] as const)(
  'normalizes buffered spawn failure with %s ordering',
  async (order) => {
    const { fake } = setup();
    const command = fake.start();
    await fixtureTurn();
    const report = () =>
      command.child.message({
        type: 'spawn-failed',
        error: {
          name: 'Error',
          message: 'spawn missing ENOENT',
          code: 'ENOENT',
        },
      });
    if (order === 'exit-first') command.child.emit('exit', null, 'SIGKILL');
    report();
    fake.rows.delete(command.child.pid);
    fake.rows.delete(command.child.workloadPid);
    await command.child.close(null, 'SIGKILL');
    const result = await command.running;
    expect(result).toMatchObject({
      status: null,
      signal: null,
      terminationSource: null,
      spawnError: { code: 'ENOENT' },
    });
    const historical = { ...result };
    command.child.message({
      type: 'target-exit',
      status: 9,
      signal: 'SIGTERM',
    });
    expect(result).toEqual(historical);
  }
);

it('retains an unexpected supervisor exit alongside a subsequent inspection failure', async () => {
  const { fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  fake.failInspection(new Error('cleanup inspection failed'));
  await command.child.close(null, 'SIGKILL');
  const result = await command.running;
  expect(result.error?.message).toContain('cleanup inspection failed');
  expect(result.error?.message).toContain(
    'exited before reporting its workload'
  );
});

it('does not describe an inspection-driven cleanup exit as an unexpected crash', async () => {
  const { fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  fake.failInspection();
  command.child.message({
    type: 'inspection-failed',
    stage: 'workload',
    error: { name: 'Error', message: 'startup inspection failed' },
  });
  await command.child.close(null, 'SIGKILL');
  expect((await command.running).error?.message).not.toContain(
    'exited before reporting its workload'
  );
});
