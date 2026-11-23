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
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}));
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
  send = vi.fn((_message: unknown, callback: (error?: Error) => void) =>
    callback()
  );
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
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() =>
      child.emit('message', { type: 'authorization-ready' })
    );
    return child;
  });
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

it.each(['ETIMEDOUT', 'EINTR', 'EAGAIN', 'EBUSY'])(
  'retries transient %s inspection before granting group authority',
  async (code) => {
    mocks.inspect.mockImplementationOnce(() => {
      throw new Error('Inspection temporarily unavailable', {
        cause: { code },
      });
    });
    const [fixture] = await Promise.all([
      launchE2EFixture(),
      vi.advanceTimersByTimeAsync(20),
    ]);
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
    expect(mocks.validate).toHaveBeenCalledOnce();
    await fixture.dispose();
  }
);
it('retains the last inspection cause when the original startup budget expires', async () => {
  const failure = new Error('Inspection timed out', {
    cause: { code: 'ETIMEDOUT' },
  });
  mocks.inspect.mockImplementation(() => {
    throw failure;
  });
  await Promise.all([
    expect(launchE2EFixture()).rejects.toMatchObject({
      message: 'Fixture process-group confirmation timed out',
      cause: failure,
    }),
    vi.advanceTimersByTimeAsync(5000),
  ]);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(mocks.validate).not.toHaveBeenCalled();
});
it.each(['ENOENT', 'EACCES'])(
  'does not retry an unsupported inspection with %s',
  async (code) => {
    const failure = new Error('Inspection cannot run', { cause: { code } });
    mocks.inspect.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(launchE2EFixture()).rejects.toBe(failure);
    expect(mocks.inspect).toHaveBeenCalledOnce();
  }
);
it.each(['inspect', 'signal'] as const)(
  'preserves the leader after cleanup %s fails and later joins a fresh attempt',
  async (stage) => {
    const fixture = await launchE2EFixture();
    const failure = new Error('Group cleanup unavailable');
    mocks[stage].mockImplementationOnce(() => {
      throw failure;
    });
    await Promise.all([
      expect(fixture.dispose()).rejects.toMatchObject({ cause: failure }),
      vi.advanceTimersByTimeAsync(3000),
    ]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.exitCode).toBeNull();
    expect(mocks.rm).not.toHaveBeenCalled();
    await fixture.dispose();
    expect(mocks.rm).toHaveBeenCalledOnce();
  }
);
it('retains authenticated continuity for descendants created after launch', async () => {
  const actual = await vi.importActual<
    typeof import('@tests/support/fixture-process-groups')
  >('@tests/support/fixture-process-groups');
  const leader = {
    pid: child.pid,
    parent: process.pid,
    group: child.pid,
    state: 'S',
    started: 'root-birth',
  };
  const descendant = {
    ...leader,
    pid: child.pid + 1,
    parent: child.pid,
    started: 'child-birth',
  };
  const rows = new Map([[leader.pid, leader]]);
  const group = actual.seedFixtureProcessGroup(leader, rows);
  mocks.inspect.mockReturnValue(rows);
  mocks.validate.mockReturnValue(group);
  const fixture = await launchE2EFixture();
  mocks.inspect.mockImplementationOnce(() => {
    throw new Error('ps timeout');
  });
  await Promise.all([
    expect(fixture.dispose()).rejects.toThrow('cleanup remains unresolved'),
    vi.advanceTimersByTimeAsync(3000),
  ]);
  expect(child.kill).not.toHaveBeenCalled();
  rows.set(descendant.pid, descendant);
  mocks.signal.mockImplementation((capability, _signal, snapshot) => {
    expect(actual.fixtureGroupIsLive(capability, snapshot)).toBe(true);
    expect(capability.members.get(descendant.pid)).toBe('child-birth');
    child.kill('SIGKILL');
  });
  await fixture.dispose();
  expect(mocks.rm).toHaveBeenCalledOnce();
});
it('clears historical execution failures after a successful nonconfirming snapshot', async () => {
  const old = new Error('Old timeout', { cause: { code: 'ETIMEDOUT' } });
  mocks.inspect
    .mockImplementationOnce(() => {
      throw old;
    })
    .mockReturnValue(new Map());
  await Promise.all([
    expect(launchE2EFixture()).rejects.toMatchObject({
      message: 'Fixture process-group confirmation timed out',
      cause: undefined,
    }),
    vi.advanceTimersByTimeAsync(5000),
  ]);
  expect(child.send).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});
it('does not inspect or authorize before the bootstrap announces readiness', async () => {
  mocks.spawn.mockReturnValue(child);
  const launch = launchE2EFixture();
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(child.send).not.toHaveBeenCalled();
  child.emit('message', { type: 'authorization-ready' });
  await vi.advanceTimersByTimeAsync(20);
  const fixture = await launch;
  expect(mocks.validate).toHaveBeenCalledBefore(child.send);
  expect(child.send).toHaveBeenCalledWith(
    { type: 'authorize' },
    expect.any(Function)
  );
  await fixture.dispose();
});
it('bounds a bootstrap that never announces readiness and kills only that retained child', async () => {
  mocks.spawn.mockReturnValue(child);
  await Promise.all([
    expect(launchE2EFixture()).rejects.toThrow(
      'process-group confirmation timed out'
    ),
    vi.advanceTimersByTimeAsync(5000),
  ]);
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.signal).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(mocks.rm).toHaveBeenCalledOnce();
});
it('rejects authorization disconnection and recovers the unstarted bootstrap', async () => {
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit('disconnect'));
    return child;
  });
  await expect(launchE2EFixture()).rejects.toThrow(
    'authorization IPC disconnected'
  );
  expect(mocks.signal).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});
it('preserves an authorization-delivery failure and cleans with its established capability', async () => {
  const failure = new Error('IPC send failed');
  child.send.mockImplementation((_message, callback) => callback(failure));
  await expect(launchE2EFixture()).rejects.toBe(failure);
  expect(mocks.signal).toHaveBeenCalledOnce();
  expect(mocks.rm).toHaveBeenCalledOnce();
});
it('accepts buffered IPC delivered after process exit and before disconnect', async () => {
  const fixture = await launchE2EFixture();
  child.exitCode = 0;
  child.emit('exit', 0, null);
  const message = fixture.message('buffered');
  child.emit('message', { type: 'buffered' });
  child.emit('disconnect');
  child.emit('close', 0, null);
  const [received] = await Promise.all([
    message,
    vi.advanceTimersByTimeAsync(20),
  ]);
  expect(received).toEqual({ type: 'buffered' });
  await fixture.dispose();
});
it('reports a missing message only after the IPC channel drains', async () => {
  const fixture = await launchE2EFixture();
  child.emit('message', { type: 'last' });
  child.emit('disconnect');
  await expect(fixture.message('last')).resolves.toEqual({ type: 'last' });
  await expect(fixture.message('absent')).rejects.toThrow(
    'IPC closed before absent'
  );
  await fixture.dispose();
});
it('retains the twenty-second message deadline when IPC remains open', async () => {
  const fixture = await launchE2EFixture();
  await Promise.all([
    expect(fixture.message('absent')).rejects.toThrow(
      'message timed out: absent'
    ),
    vi.advanceTimersByTimeAsync(20_000),
  ]);
  await fixture.dispose();
});
