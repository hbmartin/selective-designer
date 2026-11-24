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
it.each(['inspect', 'signal'] as const)(
  'rejects promptly without awaiting an unrequested exit after cleanup %s fails',
  async (stage) => {
    const fixture = await launchE2EFixture();
    const failure = new Error('Group cleanup unavailable');
    mocks[stage].mockImplementationOnce(() => {
      throw failure;
    });
    const outcome = await fixture.dispose().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(outcome).toMatchObject({ errors: [failure], cause: failure });
    expect(child.kill).not.toHaveBeenCalled();
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
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.stderr.emit('data', 'bootstrap stalled'));
    return child;
  });
  await Promise.all([
    expect(launchE2EFixture()).rejects.toThrow(
      'Fixture bootstrap authorization readiness timed out; output=bootstrap stalled'
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

it('checks the deadline after validation without authorizing a late child', async () => {
  mocks.validate.mockImplementation(() => {
    vi.advanceTimersByTime(5001);
    return { pid: child.pid };
  });
  await expect(launchE2EFixture()).rejects.toThrow(
    'authorization delivery timed out'
  );
  expect(child.send).not.toHaveBeenCalled();
  expect(mocks.signal).toHaveBeenCalledOnce();
});
it('exposes the original capability for concurrent retries after launch and cleanup fail', async () => {
  const launchError = new Error('Authorization delivery failed');
  const inspectionError = new Error('Cleanup ps unavailable');
  const inspect = mocks.inspect.getMockImplementation()!;
  mocks.inspect.mockImplementationOnce(inspect).mockImplementationOnce(() => {
    throw inspectionError;
  });
  child.send.mockImplementation((_message, callback) => callback(launchError));
  let failure!: import('@tests/support/e2e-fixture-process').E2EFixtureLaunchError;
  const attempt = launchE2EFixture().catch((error) => {
    failure = error;
  });
  await vi.advanceTimersByTimeAsync(3000);
  await attempt;
  expect(failure.cause).toBe(launchError);
  expect(failure.errors[1].cause).toBe(inspectionError);
  expect(child.kill).not.toHaveBeenCalled();
  const first = failure.retryCleanup();
  const joined = failure.retryCleanup();
  expect(joined).toBe(first);
  await Promise.all([first, joined]);
  expect(mocks.signal).toHaveBeenCalledOnce();
  expect(mocks.rm).toHaveBeenCalledOnce();
  await failure.retryCleanup();
  expect(mocks.signal).toHaveBeenCalledOnce();
  expect(failure.cause).toBe(launchError);
});

it('waits for a delayed setup checkpoint within its explicit budget', async () => {
  const fixture = await launchE2EFixture();
  const waiting = fixture.waitForOutput('setup ready', 1000);
  await vi.advanceTimersByTimeAsync(200);
  child.stdout.emit('data', 'setup ready');
  await vi.advanceTimersByTimeAsync(20);
  await waiting;
  await fixture.dispose();
});
it('fails a checkpoint after stdio drains with output and status diagnostics', async () => {
  const fixture = await launchE2EFixture();
  child.stdout.emit('data', 'setup starting');
  child.exitCode = 13;
  child.emit('exit', 13, null);
  child.emit('close', 13, null);
  await expect(fixture.waitForOutput('setup ready')).rejects.toThrow(
    'exit=13, signal=null, disconnected=false; output=setup starting'
  );
  child.emit('close', 13, null);
  await fixture.dispose();
});

it('accepts a checkpoint buffered after exit and IPC disconnect', async () => {
  const fixture = await launchE2EFixture();
  child.exitCode = 0;
  child.emit('exit', 0, null);
  child.emit('disconnect');
  const waiting = fixture.waitForOutput('final checkpoint');
  child.stdout.emit('data', 'final checkpoint');
  child.emit('close', 0, null);
  await vi.advanceTimersByTimeAsync(20);
  await waiting;
  await fixture.dispose();
});
it('reports transport diagnostics once without failing successful cleanup', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fixture = await launchE2EFixture();
  const failure = Object.assign(new Error('IPC transport failed'), {
    code: 'EPIPE',
  });
  child.emit('error', failure);
  await fixture.dispose();
  await fixture.dispose();
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    'E2E fixture transport diagnostic:',
    failure
  );
  warning.mockRestore();
});

it('reports passive transport errors once without duplicating the failed-launch aggregate', async () => {
  const launchError = new Error('Authorization failed');
  const cleanupError = new Error('Cleanup inspection unavailable');
  const transportError = new Error('Passive IPC channel diagnostic');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const inspect = mocks.inspect.getMockImplementation()!;
  mocks.inspect.mockImplementationOnce(inspect).mockImplementationOnce(() => {
    throw cleanupError;
  });
  child.send.mockImplementation((_message, callback) => {
    child.emit('error', transportError);
    callback(launchError);
  });
  try {
    let failure!: import('@tests/support/e2e-fixture-process').E2EFixtureLaunchError;
    await launchE2EFixture().catch((error) => {
      failure = error;
    });
    expect(failure.errors).toEqual([
      launchError,
      expect.objectContaining({ cause: cleanupError }),
    ]);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'E2E fixture transport diagnostic:',
      transportError
    );
    await failure.retryCleanup();
    expect(warning).toHaveBeenCalledOnce();
  } finally {
    warning.mockRestore();
  }
});

it.each([
  ['restarted', 'restart-failed'],
  ['abandoned-change-delivered', 'abandoned-change-failed'],
])(
  'rejects %s promptly on its explicit failure outcome',
  async (success, failure) => {
    const fixture = await launchE2EFixture();
    const afterIndex = fixture.messages.length;
    const waiting = fixture.message(success, {
      failureTypes: [failure],
      afterIndex,
    });
    child.emit('message', { type: failure, error: 'Original action failure' });
    await Promise.all([
      expect(waiting).rejects.toThrow(`${failure}: Original action failure`),
      vi.advanceTimersByTimeAsync(20),
    ]);
    expect(performance.now()).toBeLessThan(100);
    await fixture.dispose();
  }
);
it.each(['success-first', 'failure-first'])(
  'uses chronological buffered outcomes after disconnect: %s',
  async (order) => {
    const fixture = await launchE2EFixture();
    const success = { type: 'restarted' };
    const failure = { type: 'restart-failed', error: 'Buffered rejection' };
    const afterIndex = fixture.messages.length;
    for (const message of order === 'success-first'
      ? [success, failure]
      : [failure, success])
      child.emit('message', message);
    child.emit('exit', 0, null);
    child.emit('disconnect');
    const outcome = fixture.message('restarted', {
      failureTypes: ['restart-failed'],
      afterIndex,
    });
    if (order === 'success-first')
      await expect(outcome).resolves.toEqual(success);
    else await expect(outcome).rejects.toThrow('Buffered rejection');
    await expect(fixture.message('restart-failed')).resolves.toEqual(failure);
    await fixture.dispose();
  }
);
it('limits repeated action outcomes to an explicit buffer index without consuming history', async () => {
  const fixture = await launchE2EFixture();
  child.emit('message', { type: 'restarted' });
  const afterIndex = fixture.messages.length;
  child.emit('message', {
    type: 'restart-failed',
    error: 'Second action failed',
  });
  await expect(
    fixture.message('restarted', {
      afterIndex,
      failureTypes: ['restart-failed'],
    })
  ).rejects.toThrow('Second action failed');
  await expect(fixture.message('restarted')).resolves.toEqual({
    type: 'restarted',
  });
  expect(fixture.messages).toHaveLength(afterIndex + 1);
  await fixture.dispose();
});

it('rejects a missing action cursor immediately without changing historical lookups', async () => {
  const fixture = await launchE2EFixture();
  await expect(
    // @ts-expect-error Failure-aware waits require a pre-send cursor.
    fixture.message('restarted', { failureTypes: ['restart-failed'] })
  ).rejects.toThrow('require a cursor captured before sending');
  child.emit('message', { type: 'restarted' });
  await expect(fixture.message('restarted')).resolves.toEqual({
    type: 'restarted',
  });
  await fixture.dispose();
});
it.each([-1, 0.5, NaN, Infinity, 10000])(
  'rejects invalid action cursor %s before waiting',
  async (afterIndex) => {
    const fixture = await launchE2EFixture();
    await expect(
      fixture.message('restarted', {
        failureTypes: ['restart-failed'],
        afterIndex,
      })
    ).rejects.toThrow('integer within the current buffer');
    await fixture.dispose();
  }
);
it('ignores an earlier failure and accepts a fast response buffered after the pre-send cursor', async () => {
  const fixture = await launchE2EFixture();
  child.emit('message', { type: 'restart-failed', error: 'Old action' });
  const afterIndex = fixture.messages.length;
  child.emit('message', { type: 'restarted' });
  await expect(
    fixture.message('restarted', {
      failureTypes: ['restart-failed'],
      afterIndex,
    })
  ).resolves.toEqual({ type: 'restarted' });
  await expect(fixture.message('restart-failed')).resolves.toMatchObject({
    error: 'Old action',
  });
  await fixture.dispose();
});
