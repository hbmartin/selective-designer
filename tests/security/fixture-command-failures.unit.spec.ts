import {
  acknowledgeFixtureCleanupFailure,
  createWorkflowFixture,
  disposeFixtureCommands,
  disposeWorkflowFixture,
  disposeWorkflowFixtures,
  registerFixtureProcessGroup,
  runFixtureCommand,
  type WorkflowFixture,
} from '@tests/support/workflow-fixtures';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

const fixtures: WorkflowFixture[] = [];
const makeFixture = () => {
  const fixture = createWorkflowFixture();
  fixtures.push(fixture);
  return fixture;
};
afterEach(async () => {
  try {
    await disposeWorkflowFixtures(fixtures);
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  }
});

function fakeChild(
  pid?: number,
  streams: 'pipes' | null | undefined = 'pipes'
) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: (streams === 'pipes' ? new PassThrough() : streams) as
      | PassThrough
      | null
      | undefined,
    stderr: (streams === 'pipes' ? new PassThrough() : streams) as
      | PassThrough
      | null
      | undefined,
    unref: vi.fn(),
  });
}
function mockSpawn(child: ReturnType<typeof fakeChild>) {
  vi.spyOn(childProcess, 'spawn').mockReturnValue(
    child as unknown as childProcess.ChildProcess
  );
  syncBuiltinESMExports();
}

it.each(['EMFILE', 'ENFILE'])(
  'normalizes synchronous %s without inspecting or signaling',
  async (code) => {
    const fixture = makeFixture();
    const failure = Object.assign(new Error(`spawn ${code}`), { code });
    vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw failure;
    });
    const inspect = vi.spyOn(childProcess, 'spawnSync');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    syncBuiltinESMExports();
    const result = await runFixtureCommand(process.execPath, [], fixture);
    expect(result).toMatchObject({
      error: failure,
      spawnError: failure,
      cleanupFailures: [],
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  }
);

it.each([null, undefined])(
  'handles async descriptor errors with %s stdio and no PID',
  async (streams) => {
    const fixture = makeFixture();
    const child = fakeChild(undefined, streams);
    // Explicit assignment avoids the default argument replacing undefined.
    child.stdout = streams;
    child.stderr = streams;
    mockSpawn(child);
    const inspect = vi.spyOn(childProcess, 'spawnSync');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    syncBuiltinESMExports();
    const running = runFixtureCommand(process.execPath, [], fixture);
    const error = Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' });
    child.emit('error', error);
    child.emit('close');
    const result = await running;
    expect(result.spawnError).toBe(error);
    expect(result.cleanupFailures).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  }
);

function syntheticCommand(fixture: WorkflowFixture, pipes = false) {
  const child = fakeChild(2_000_001);
  let alive = true;
  let failing = false;
  const inspect = vi.spyOn(childProcess, 'spawnSync').mockImplementation(() => {
    if (failing) throw new Error('primary inspection fault');
    return {
      status: 0,
      signal: null,
      pid: 1,
      output: [],
      stderr: '',
      stdout:
        `${process.pid} ${process.ppid} ${process.pid} S runner\n` +
        (alive ? '2000001 1 2000001 S original\n' : ''),
    };
  });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    alive = false;
    return true;
  });
  mockSpawn(child);
  const running = runFixtureCommand(process.execPath, [], fixture, {
    terminationGraceMs: 0,
  });
  child.emit('spawn');
  if (!pipes) {
    child.stdout?.end();
    child.stderr?.end();
    child.emit('close');
  }
  return {
    child,
    running,
    inspect,
    kill,
    fail: () => {
      failing = true;
    },
    recover: () => {
      failing = false;
    },
  };
}

it('retains a settled group failure across disposal and clears it only on fresh verification', async () => {
  const fixture = makeFixture();
  const command = syntheticCommand(fixture);
  command.fail();
  command.child.emit('exit', 0, null);
  const result = await command.running;
  const error = result.error;
  expect(result.cleanupFailures.map((failure) => failure.kind)).toEqual([
    'owned-groups-unconfirmed',
  ]);
  await expect(disposeWorkflowFixture(fixture)).rejects.toThrow('retained');
  expect(fs.existsSync(fixture.root)).toBe(true);
  expect(() =>
    acknowledgeFixtureCleanupFailure(fixture, result.cleanupFailures[0]!, {
      reason: 'cannot bypass ownership',
    })
  ).toThrow('output-drain');
  command.recover();
  await disposeWorkflowFixture(fixture);
  expect(command.kill).toHaveBeenCalledWith(-2_000_001, 'SIGTERM');
  expect(result.error).toBe(error);
  expect(result.cleanupFailures).toHaveLength(1);
});

it('preserves primary inspection errors and separate sticky pipe tokens through verified recovery', async () => {
  const fixture = makeFixture();
  const command = syntheticCommand(fixture, true);
  command.fail();
  command.child.emit('exit', 0, null);
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
  command.recover();
  await expect(disposeFixtureCommands(fixture)).rejects.toThrow('unresolved');
  for (const invalid of [
    Object.freeze({ ...tokens[0]! }),
    result.cleanupFailures[0]!,
  ]) {
    expect(() =>
      acknowledgeFixtureCleanupFailure(fixture, invalid, {
        reason: 'fabricated or owned',
      })
    ).toThrow('output-drain');
  }
  const other = makeFixture();
  expect(() =>
    acknowledgeFixtureCleanupFailure(other, tokens[0]!, { reason: 'foreign' })
  ).toThrow('output-drain');
  expect(() =>
    acknowledgeFixtureCleanupFailure(fixture, tokens[0]!, { reason: ' ' })
  ).toThrow('reason');
  acknowledgeFixtureCleanupFailure(fixture, tokens[0]!, {
    reason: 'Known groups stopped; missing output accepted',
  });
  await expect(disposeWorkflowFixture(fixture)).rejects.toThrow('retained');
  expect(() =>
    acknowledgeFixtureCleanupFailure(fixture, tokens[0]!, {
      reason: 'already resolved',
    })
  ).toThrow('output-drain');
  acknowledgeFixtureCleanupFailure(fixture, tokens[1]!, {
    reason: 'Second pipe loss explicitly accepted',
  });
  await disposeWorkflowFixture(fixture);
  expect(result.error).toBe(error);
  expect(result.cleanupFailures).toHaveLength(3);
});

it('seals registration synchronously when cancellation starts', async () => {
  const fixture = makeFixture();
  const command = syntheticCommand(fixture);
  const disposal = disposeFixtureCommands(fixture);
  await expect(registerFixtureProcessGroup(fixture, 2_000_001)).rejects.toThrow(
    'closing'
  );
  await disposal;
  await command.running;
});

it('does not retry an initial inspection failure until explicit later disposal', async () => {
  const fixture = makeFixture();
  const child = fakeChild(2_000_001);
  mockSpawn(child);
  const inspect = vi.spyOn(childProcess, 'spawnSync').mockImplementation(() => {
    throw new Error('initial inspection failure');
  });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  syncBuiltinESMExports();
  const running = runFixtureCommand(process.execPath, [], fixture);
  child.stdout?.end();
  child.stderr?.end();
  child.emit('close');
  child.emit('spawn');
  const result = await running;
  expect(inspect).toHaveBeenCalledOnce();
  expect(kill).not.toHaveBeenCalled();
  expect(result.cleanupFailures[0]?.kind).toBe('owned-groups-unconfirmed');
  inspect.mockReturnValue({
    status: 0,
    signal: null,
    pid: 1,
    output: [],
    stdout: `${process.pid} ${process.ppid} ${process.pid} S runner\n`,
    stderr: '',
  });
  await disposeWorkflowFixture(fixture);
  expect(result.cleanupFailures).toHaveLength(1);
  expect(Object.isFrozen(result.cleanupFailures)).toBe(true);
});

it('rejects registration through a replaced originating command without signaling its replacement', async () => {
  const fixture = makeFixture();
  const command = syntheticCommand(fixture);
  command.inspect.mockReturnValue({
    status: 0,
    signal: null,
    pid: 1,
    output: [],
    stderr: '',
    stdout: `${process.pid} ${process.ppid} ${process.pid} S runner\n2000001 1 2000001 S replacement\n2000002 2000001 2000002 S unrelated\n`,
  });
  await expect(registerFixtureProcessGroup(fixture, 2_000_002)).rejects.toThrow(
    'active fixture command'
  );
  command.child.emit('exit', 0, null);
  expect((await command.running).error).toBeUndefined();
  expect(command.kill).not.toHaveBeenCalled();
});
