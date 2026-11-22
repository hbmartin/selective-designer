import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { launchE2EFixture } from '@tests/support/e2e-fixture-process';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  inspect: vi.fn(),
  validate: vi.fn(),
  signal: vi.fn(),
  rm: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: async () => '/synthetic/e2e-owned',
  writeFile: async () => {},
  rm: mocks.rm,
}));
vi.mock('@tests/support/fixture-process-groups', () => ({
  inspectFixtureProcesses: mocks.inspect,
  validateDetachedFixtureGroup: mocks.validate,
  signalFixtureGroup: mocks.signal,
}));

class FakeChild extends EventEmitter {
  pid = 2_000_100;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
    return true;
  });
}
let child: FakeChild;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  child = new FakeChild();
  mocks.spawn.mockReturnValue(child);
  mocks.inspect.mockImplementation(
    () =>
      new Map([
        [
          child.pid,
          {
            pid: child.pid,
            group: child.pid,
            parent: process.pid,
            state: 'S',
            started: 'synthetic-birth',
          },
        ],
      ])
  );
  mocks.validate.mockReturnValue({ pid: child.pid });
  mocks.signal.mockImplementation(() => child.kill('SIGKILL'));
  mocks.rm.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(['inspect', 'validate'] as const)(
  'recovers the retained direct child after %s fails',
  async (stage) => {
    const failure = new Error(`Controlled ${stage} failure`);
    mocks[stage].mockImplementationOnce(() => {
      throw failure;
    });
    await expect(launchE2EFixture()).rejects.toBe(failure);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mocks.signal).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith('/synthetic/e2e-owned', {
      recursive: true,
      force: true,
    });
  }
);
it('retains the original failure and root when direct-child cleanup is unconfirmed', async () => {
  const failure = new Error('Inspection unavailable');
  mocks.inspect.mockImplementationOnce(() => {
    throw failure;
  });
  child.kill.mockImplementation(() => true);
  const attempt = launchE2EFixture();
  await Promise.all([
    expect(attempt).rejects.toMatchObject({
      cause: failure,
      errors: [
        failure,
        expect.objectContaining({
          message: expect.stringContaining('retained /synthetic/e2e-owned'),
        }),
      ],
    }),
    vi.advanceTimersByTimeAsync(3000),
  ]);
  expect(mocks.rm).not.toHaveBeenCalled();
});
it('reports inherited pipes that remain open after process exit', async () => {
  const fixture = await launchE2EFixture();
  child.exitCode = 0;
  child.emit('exit', 0, null);
  const pending = fixture.waitForExit();
  await Promise.all([
    expect(pending).rejects.toThrow('output drain remains unconfirmed'),
    vi.advanceTimersByTimeAsync(12_000),
  ]);
  expect(mocks.rm).not.toHaveBeenCalled();
  child.emit('close', 0, null);
  await fixture.dispose();
  expect(mocks.rm).toHaveBeenCalledOnce();
});
it('uses one twelve-second deadline for process exit and output draining', async () => {
  const fixture = await launchE2EFixture();
  const pending = fixture.waitForExit();
  await Promise.all([
    expect(pending).rejects.toThrow('output drain remains unconfirmed'),
    (async () => {
      await vi.advanceTimersByTimeAsync(11_900);
      child.exitCode = 0;
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(100);
    })(),
  ]);
  child.emit('close', 0, null);
  await fixture.dispose();
});
it('bounds disposal and retains the root until later verified recovery', async () => {
  const fixture = await launchE2EFixture();
  mocks.signal.mockImplementationOnce(() => {});
  const disposal = fixture.dispose();
  await Promise.all([
    expect(disposal).rejects.toThrow('cleanup remains unresolved'),
    vi.advanceTimersByTimeAsync(3000),
  ]);
  expect(mocks.rm).not.toHaveBeenCalled();
  await fixture.dispose();
  expect(mocks.rm).toHaveBeenCalledOnce();
});
