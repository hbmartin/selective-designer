import { syncBuiltinESMExports } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import {
  fixtureCommandFakes,
  fixtureTurn,
} from '@tests/support/fixture-command-fakes';
import {
  captureFixtureProcessGroup,
  createWorkflowFixture,
  disposeCapturedFixtureProcessGroup,
  disposeFixtureCommands,
  disposeWorkflowFixtures,
  fixtureEnvironment,
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
    if (vi.isFakeTimers()) await vi.runAllTimersAsync();
    for (const harness of harnesses.splice(0)) await harness.cleanup();
    await disposeWorkflowFixtures(fixtures);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  }
});

it('snapshots caller arguments and environment before the ownership handshake', async () => {
  const { fixture, fake } = setup();
  const args = ['original'];
  const env = fixtureEnvironment(fixture);
  env.FIXTURE_MODE = 'original';
  const running = runFixtureCommand(process.execPath, args, fixture, { env });
  args[0] = 'mutated';
  env.FIXTURE_MODE = 'mutated';
  await fixtureTurn();
  const child = fake.children[0]!;
  const payload = child.sent.find((message) => message.type === 'start')!;
  expect(payload.args).toEqual(['original']);
  expect(payload.env).toMatchObject({ FIXTURE_MODE: 'original' });
  child.targetExit();
  expect((await running).command).toBe(
    [process.execPath, 'original'].join(' ')
  );
});

it('preserves inherited environment entries with own shadowing and undefined omission', async () => {
  const { fixture, fake } = setup();
  const env: NodeJS.ProcessEnv = Object.assign(
    Object.create({
      INHERITED: 'original',
      SHADOWED: 'parent',
      OMITTED: 'parent',
    }),
    { PATH: fixture.bin, SHADOWED: 'own', OMITTED: undefined }
  );
  const running = runFixtureCommand(process.execPath, [], fixture, { env });
  Object.getPrototypeOf(env).INHERITED = 'mutated';
  await fixtureTurn();
  const child = fake.children[0]!;
  expect(child.sent[0]?.env).toEqual({
    PATH: fixture.bin,
    INHERITED: 'original',
    SHADOWED: 'own',
  });
  child.targetExit();
  await running;
});

it('registers a live owner without awaiting an unrelated startup', async () => {
  const { fixture, fake } = setup();
  const first = fake.start();
  await fixtureTurn();
  fake.row(4_000_001, first.child.workloadPid);
  const second = fake.start();
  second.child.owned = vi.fn();
  const registration = captureFixtureProcessGroup(fixture, 4_000_001);
  await expect(registration).resolves.toMatchObject({ pid: 4_000_001 });
  expect(second.child.released).toBe(false);
});

it('waits for the ancestor command birth report before registering', async () => {
  const { fixture, fake } = setup();
  const command = fake.start();
  command.child.workload = vi.fn();
  await fixtureTurn();
  const identity = fake.row(
    command.child.workloadPid,
    command.child.pid,
    command.child.pid
  );
  fake.row(4_000_001, command.child.workloadPid);
  let registered = false;
  const registration = captureFixtureProcessGroup(fixture, 4_000_001).then(
    (capability) => {
      registered = true;
      return capability;
    }
  );
  await fixtureTurn();
  expect(registered).toBe(false);
  command.child.message({ type: 'workload', identity });
  await expect(registration).resolves.toMatchObject({ pid: 4_000_001 });
});

it('rejects registration when disposal closes a fixture during the relevant startup', async () => {
  const { fixture, fake } = setup();
  const command = fake.start();
  command.child.workload = vi.fn();
  await fixtureTurn();
  fake.row(command.child.workloadPid, command.child.pid, command.child.pid);
  fake.row(4_000_001, command.child.workloadPid);
  const registration = captureFixtureProcessGroup(fixture, 4_000_001).catch(
    (error: unknown) => error
  );
  const disposal = disposeFixtureCommands(fixture);
  await expect(registration).resolves.toMatchObject({
    message: expect.stringContaining('closing or disposed'),
  });
  await disposal;
  expect(fake.kill.mock.calls.some(([pid]) => pid === -4_000_001)).toBe(false);
});

it('keeps detached TERM available while the root retires privately', async () => {
  const { fixture, fake } = setup();
  const command = fake.start({ terminationGraceMs: 150 });
  await fixtureTurn();
  fake.row(4_000_001, command.child.workloadPid);
  await registerFixtureProcessGroup(fixture, 4_000_001);
  command.child.targetExit();
  await command.running;
  expect(
    fake.kill.mock.calls
      .filter(([pid]) => pid === -4_000_001)
      .map(([, signal]) => signal)
  ).toEqual(['SIGTERM']);
});

it('reports a sibling failure only to fixture-wide disposal', async () => {
  const { fixture, fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  fake.row(4_000_001, command.child.workloadPid);
  fake.row(4_000_002, command.child.workloadPid);
  await captureFixtureProcessGroup(fixture, 4_000_001);
  const own = await captureFixtureProcessGroup(fixture, 4_000_002);
  command.child.targetExit();
  await command.running;
  fake.rows.delete(4_000_001);
  fake.row(4_000_003, 1, 4_000_001, 'unrelated');
  const disposal = disposeFixtureCommands(fixture).catch(
    (error: unknown) => error
  );
  await expect(
    disposeCapturedFixtureProcessGroup(own)
  ).resolves.toBeUndefined();
  expect(fake.rows.has(4_000_002)).toBe(false);
  await expect(disposal).resolves.toMatchObject({
    message: expect.stringContaining('unresolved'),
  });
});

it('bounds command waiting without shortening or duplicating the shared pass', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { fixture, fake } = setup();
  const cancel = new AbortController();
  const command = fake.start({ signal: cancel.signal });
  await fixtureTurn();
  fake.row(4_000_001, command.child.workloadPid);
  const capability = await captureFixtureProcessGroup(fixture, 4_000_001);
  await registerFixtureProcessGroup(fixture, 4_000_001);
  const original = fake.kill.getMockImplementation()!;
  fake.kill.mockImplementation((pid, signal) => {
    if (pid === -4_000_001 && signal === 'SIGTERM') return true;
    return original(pid, signal);
  });
  const disposal = disposeCapturedFixtureProcessGroup(capability);
  await fixtureTurn();
  cancel.abort('bounded cleanup');
  await vi.advanceTimersByTimeAsync(1_000);
  const result = await command.running;
  const historicalError = result.error;
  const tokens = result.cleanupFailures;
  expect(performance.now()).toBe(1_000);
  expect(tokens.map((failure) => failure.kind)).toEqual([
    'owned-groups-unconfirmed',
  ]);
  expect(unresolvedFixtureCleanupFailures(fixture, tokens)).toEqual(tokens);
  const joined = disposeCapturedFixtureProcessGroup(capability);
  expect(
    fake.kill.mock.calls
      .filter(([pid]) => pid === -4_000_001)
      .map(([, signal]) => signal)
  ).toEqual(['SIGTERM']);
  await vi.advanceTimersByTimeAsync(1_050);
  await Promise.all([disposal, joined]);
  expect(
    fake.kill.mock.calls
      .filter(([pid]) => pid === -4_000_001)
      .map(([, signal]) => signal)
  ).toEqual(['SIGTERM', 'SIGKILL']);
  expect(unresolvedFixtureCleanupFailures(fixture, tokens)).toEqual([]);
  expect(result.error).toBe(historicalError);
  expect(Object.isFrozen(tokens)).toBe(true);
});

it.each([
  ['start', 'throw'],
  ['start', 'callback'],
  ['retire', 'throw'],
  ['retire', 'callback'],
] as const)(
  'reconciles fresh process evidence after %s IPC %s failure',
  async (stage, delivery) => {
    const { fixture, fake } = setup();
    const command = fake.start({ terminationGraceMs: 100 });
    if (stage === 'retire') await fixtureTurn();
    const original = command.child.send.bind(command.child);
    const failure = new Error('transport failed');
    command.child.send = (message, callback) => {
      if (message.type !== stage) return original(message, callback);
      if (stage === 'start') {
        command.child.released = true;
        command.child.workload();
      } else {
        fake.rows.delete(command.child.pid);
        void command.child.close(0, null);
      }
      if (delivery === 'throw') throw failure;
      queueMicrotask(() => callback?.(failure));
      return false;
    };
    if (stage === 'retire') command.child.targetExit();
    const result = await command.running;
    expect(result.error?.message).toContain('transport failed');
    expect(
      unresolvedFixtureCleanupFailures(fixture, result.cleanupFailures)
    ).toEqual([]);
    expect(fake.inspect.mock.calls.length).toBeGreaterThan(1);
  }
);

it.each(['exit-first', 'target-first'] as const)(
  'reconciles buffered workload success with %s events',
  async (order) => {
    const { fake } = setup();
    const command = fake.start({ terminationGraceMs: 100 });
    await fixtureTurn();
    if (order === 'exit-first') command.child.emit('exit', 0, null);
    command.child.targetExit(0);
    if (order === 'target-first') command.child.emit('exit', 0, null);
    const result = await command.running;
    expect(result).toMatchObject({
      status: 0,
      terminationSource: 'workload',
      cleanupFailures: [],
    });
    expect(result.error).toBeUndefined();
    command.child.message({ type: 'target-exit', status: 9, signal: null });
    expect(result.status).toBe(0);
  }
);

it('reports a supervisor exit when no workload result arrives before final reconciliation', async () => {
  const { fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  fake.rows.delete(command.child.pid);
  fake.rows.delete(command.child.workloadPid);
  await command.child.close(0, null);
  expect((await command.running).error?.message).toContain(
    'exited before reporting its workload'
  );
});

it('keeps fixture disposal pending until an automatic scoped pass retires', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { fixture, fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  fake.row(4_000_001, command.child.workloadPid);
  const capability = await captureFixtureProcessGroup(fixture, 4_000_001);
  await registerFixtureProcessGroup(fixture, 4_000_001);
  const original = fake.kill.getMockImplementation()!;
  fake.kill.mockImplementation((pid, signal) =>
    pid === -4_000_001 && signal === 'SIGTERM' ? true : original(pid, signal)
  );
  const scoped = disposeCapturedFixtureProcessGroup(capability);
  await fixtureTurn();
  let finished = false;
  const disposal = disposeFixtureCommands(fixture).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(1_100);
  const result = await command.running;
  const historical = result.error;
  expect(finished).toBe(false);
  expect(result.cleanupFailures.map((failure) => failure.kind)).toEqual([
    'owned-groups-unconfirmed',
  ]);
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.all([scoped, disposal]);
  expect(finished).toBe(true);
  expect(
    unresolvedFixtureCleanupFailures(fixture, result.cleanupFailures)
  ).toEqual([]);
  expect(result.error).toBe(historical);
  expect(
    fake.kill.mock.calls
      .filter(([pid]) => pid === -4_000_001)
      .map(([, signal]) => signal)
  ).toEqual(['SIGTERM', 'SIGKILL']);
});

it('joins a recovery pass installed after the disposal snapshot and reconciles historical rejections', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { fixture, fake } = setup();
  const command = fake.start();
  await fixtureTurn();
  fake.row(4_000_001, command.child.workloadPid);
  const capability = await captureFixtureProcessGroup(fixture, 4_000_001);
  await registerFixtureProcessGroup(fixture, 4_000_001);
  const original = fake.kill.getMockImplementation()!;
  let recovering = false;
  fake.kill.mockImplementation((pid, signal) => {
    if (pid === -4_000_001 && (signal === 'SIGTERM' || !recovering))
      return true;
    return original(pid, signal);
  });
  fake.start({ terminationGraceMs: 2_500 });
  await fixtureTurn();
  let finished = false;
  const disposal = disposeFixtureCommands(fixture).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(1_100);
  await command.running;
  recovering = true;
  const scoped = disposeCapturedFixtureProcessGroup(capability);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(2_100);
  await Promise.all([scoped, disposal]);
  expect(finished).toBe(true);
});

it('publishes a single deadline token when both a caller and its shared pass expire', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const { fixture, fake } = setup();
  const cancel = new AbortController();
  const command = fake.start({ signal: cancel.signal });
  await fixtureTurn();
  fake.row(4_000_001, command.child.workloadPid);
  const capability = await captureFixtureProcessGroup(fixture, 4_000_001);
  await registerFixtureProcessGroup(fixture, 4_000_001);
  const original = fake.kill.getMockImplementation()!;
  fake.kill.mockImplementation((pid, signal) =>
    pid === -4_000_001 ? true : original(pid, signal)
  );
  const scoped = disposeCapturedFixtureProcessGroup(capability).catch(
    (error: unknown) => error
  );
  await fixtureTurn();
  cancel.abort('bounded wait');
  await vi.advanceTimersByTimeAsync(1_100);
  const result = await command.running;
  const historical = result.error;
  const [token] = result.cleanupFailures;
  expect(result.cleanupFailures).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2_000);
  const expired = await scoped;
  expect(expired).toBeInstanceOf(AggregateError);
  expect((expired as AggregateError).errors).toEqual([token?.error]);
  expect(result.cleanupFailures).toEqual([token]);
  expect(result.error).toBe(historical);
  expect(
    unresolvedFixtureCleanupFailures(fixture, result.cleanupFailures)
  ).toEqual([token]);
  fake.kill.mockImplementation(original);
  const recovery = disposeFixtureCommands(fixture);
  await vi.advanceTimersByTimeAsync(150);
  await recovery;
  expect(
    unresolvedFixtureCleanupFailures(fixture, result.cleanupFailures)
  ).toEqual([]);
});
