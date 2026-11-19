import {
  createFixtureScenario,
  type ScenarioOptions,
} from '@tests/support/fixture-scenario';
import {
  createWorkflowFixture,
  acknowledgeFixtureCleanupFailure,
  disposeCapturedFixtureProcessGroup,
  describeCommand,
  disposeWorkflowFixture,
  disposeWorkflowFixtures,
  registerFixtureProcessGroup,
  runFixtureCommand,
  type WorkflowFixture,
} from '@tests/support/workflow-fixtures';
import {
  fixtureGroupIsLive,
  inspectFixtureProcesses,
  signalFixtureGroup,
  validateDetachedFixtureGroup,
} from '@tests/support/fixture-process-groups';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, assert, expect, it, vi } from 'vitest';

const fixtures: WorkflowFixture[] = [];
const makeFixture = () => {
  const fixture = createWorkflowFixture();
  fixtures.push(fixture);
  return fixture;
};
const scenarios: ReturnType<typeof createFixtureScenario>[] = [];
afterEach(async () => {
  try {
    const pending = scenarios.splice(0);
    const results = await Promise.allSettled(
      pending.map(async (scope) => scope.dispose())
    );
    const errors = results.flatMap((result, index) => {
      if (result.status !== 'rejected') return [];
      scenarios.push(pending[index]!);
      return [result.reason];
    });
    try {
      await disposeWorkflowFixtures(fixtures);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, 'Scenario and fixture cleanup failed');
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    syncBuiltinESMExports();
  }
});
function stopped(pid: number) {
  const row = inspectFixtureProcesses().get(pid);
  return !row || row.state.startsWith('Z');
}
async function scenario(
  fixture: WorkflowFixture,
  detached: boolean,
  timeoutMs = 10_000,
  options: ScenarioOptions = {}
) {
  const scope = createFixtureScenario(fixture, {
    detached,
    timeoutMs,
    ...options,
  });
  scenarios.push(scope); // Safety exists before any launch/readiness await.
  return scope.start();
}

it(
  'cleans surviving descendants after a successful leader without changing its result',
  { timeout: 15_000 },
  async () => {
    const fixture = makeFixture();
    const child = await scenario(fixture, false);
    fs.writeFileSync(child.release, 'exit');
    const result = await child.running;
    assert.strictEqual(result.status, 0, describeCommand(result));
    expect(result.error).toBeUndefined();
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('descendant stdout');
    expect(stopped(child.pid)).toBe(true);
  }
);

it.each(['success', 'cancellation', 'timeout'] as const)(
  'owns registered detached groups through %s',
  { timeout: 15_000 },
  async (mode) => {
    const fixture = makeFixture();
    const child = await scenario(
      fixture,
      true,
      mode === 'timeout' ? 5_000 : 10_000
    );
    try {
      await registerFixtureProcessGroup(fixture, child.pid);
      await registerFixtureProcessGroup(fixture, child.pid);
      if (mode === 'success') fs.writeFileSync(child.release, 'exit');
      else if (mode === 'cancellation')
        child.cancel.abort('registered cancellation');
      const result = await child.running;
      assert.isUndefined(result.error, describeCommand(result));
      expect(result.aborted).toBe(mode === 'cancellation');
      expect(result.timedOut).toBe(mode === 'timeout');
      expect(result.stderr).toContain('descendant stderr');
      expect(stopped(child.pid)).toBe(true);
    } finally {
      child.cancel.abort();
      await child.dispose();
      await child.running;
    }
  }
);

it(
  'bounds inherited pipes from an unregistered daemon and reports incomplete cleanup',
  { timeout: 15_000 },
  async () => {
    const fixture = makeFixture();
    const child = await scenario(fixture, true, 10_000, { register: false });
    try {
      fs.writeFileSync(child.release, 'exit');
      await expect
        .poll(() => stopped(child.parent), { timeout: 5_000 })
        .toBe(true);
      await expect(
        registerFixtureProcessGroup(fixture, child.pid)
      ).rejects.toThrow('no longer running');
      const result = await child.running;
      expect(result.status).toBe(0);
      expect(result.cleanupError?.message).toContain(
        'unregistered daemonization'
      );
      expect(result.stdout).toContain('descendant stdout');
      expect(stopped(child.pid)).toBe(false);
    } finally {
      await child.dispose();
      const result = await child.running;
      for (const failure of result.cleanupFailures) {
        if (failure.kind === 'output-drain-unconfirmed')
          acknowledgeFixtureCleanupFailure(fixture, failure, {
            reason: 'Captured safety capability confirmed stopped',
          });
      }
    }
  }
);

it(
  'rejects invalid, runner, non-leader and unrelated groups without signaling them',
  { timeout: 15_000 },
  async () => {
    const fixture = makeFixture();
    const child = await scenario(fixture, false);
    const unrelated = await scenario(makeFixture(), true);
    try {
      for (const pid of [
        0,
        1,
        Number.NaN,
        Number.MAX_SAFE_INTEGER + 1,
        process.pid,
        process.ppid,
        child.pid,
        unrelated.pid,
      ]) {
        await expect(
          registerFixtureProcessGroup(fixture, pid)
        ).rejects.toThrow();
      }
      expect(stopped(unrelated.pid)).toBe(false);
    } finally {
      await unrelated.dispose();
      unrelated.cancel.abort();
      child.cancel.abort();
      await Promise.all([unrelated.running, child.running]);
    }
  }
);

it(
  'retains ownership after inspection failure, rejects new work and retries disposal',
  { timeout: 15_000 },
  async () => {
    const fixture = makeFixture();
    const child = await scenario(fixture, false);
    const original = childProcess.spawnSync;
    const inspect = vi
      .spyOn(childProcess, 'spawnSync')
      .mockImplementation((...args: Parameters<typeof original>) => {
        if (args[0] === '/bin/ps')
          throw new Error('injected process inspection failure');
        return original(...args);
      });
    syncBuiltinESMExports();
    try {
      const first = disposeWorkflowFixture(fixture);
      expect(disposeWorkflowFixture(fixture)).toBe(first);
      await expect(first).rejects.toThrow(`retained ${fixture.root}`);
      expect(fs.existsSync(fixture.root)).toBe(true);
      expect(() =>
        runFixtureCommand(process.execPath, ['--version'], fixture)
      ).toThrow('closing');
      await expect(
        registerFixtureProcessGroup(fixture, child.pid)
      ).rejects.toThrow('closing');
    } finally {
      inspect.mockRestore();
      syncBuiltinESMExports();
      await expect(disposeWorkflowFixture(fixture)).rejects.toThrow('retained');
      const result = await child.running;
      const history = result.error;
      for (const failure of result.cleanupFailures)
        if (failure.kind === 'output-drain-unconfirmed')
          acknowledgeFixtureCleanupFailure(fixture, failure, {
            reason: 'Explicitly verified stopped after inspection recovery',
          });
      await disposeWorkflowFixture(fixture);
      expect(result.error).toBe(history);
    }
    expect(stopped(child.pid)).toBe(true);
    expect(fs.existsSync(fixture.root)).toBe(false);
  }
);

it('attempts every fixture removal and retains failed roots for retry', async () => {
  const first = makeFixture();
  const second = makeFixture();
  const original = fs.rmSync;
  const remove = vi
    .spyOn(fs, 'rmSync')
    .mockImplementation((target, options) => {
      if (target === first.root) throw new Error('injected removal failure');
      return original(target, options);
    });
  const collection = [first, second];
  const previous = process.env.FIXTURE_CLEANUP_PROBE;
  vi.stubEnv('FIXTURE_CLEANUP_PROBE', 'temporary');
  const restore = vi.fn(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  try {
    await expect(
      disposeWorkflowFixtures(collection, restore)
    ).rejects.toBeInstanceOf(AggregateError);
    expect(collection).toEqual([first]);
    expect(restore).toHaveBeenCalledOnce();
    expect(fs.rmSync).toBe(original);
    expect(process.env.FIXTURE_CLEANUP_PROBE).toBe(previous);
    expect(fs.existsSync(first.root)).toBe(true);
    expect(fs.existsSync(second.root)).toBe(false);
  } finally {
    remove.mockRestore();
    await disposeWorkflowFixture(first);
  }
});

it('removes partial construction and preserves both construction and cleanup failures', () => {
  const originalMake = fs.mkdtempSync;
  const created: string[] = [];
  vi.spyOn(fs, 'mkdtempSync').mockImplementation((...args) => {
    const root = originalMake(...args);
    created.push(String(root));
    return root;
  });
  const link = vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
    throw new Error('injected symlink failure');
  });
  const originalRemove = fs.rmSync;
  try {
    expect(createWorkflowFixture).toThrow('injected symlink failure');
    expect(fs.existsSync(created[0]!)).toBe(false);
    const remove = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('injected construction cleanup failure');
    });
    try {
      const construct = vi.fn(createWorkflowFixture);
      expect(construct).toThrow(AggregateError);
      const failure = construct.mock.results[0]?.value as AggregateError;
      expect(failure.errors.map((error: Error) => error.message)).toEqual([
        'injected symlink failure',
        'injected construction cleanup failure',
      ]);
    } finally {
      remove.mockRestore();
    }
  } finally {
    link.mockRestore();
    for (const root of created)
      originalRemove(root, { recursive: true, force: true });
  }
});

it('refuses to signal a group whose leader identity changed', () => {
  const group = { pid: 12345, started: 'original start' };
  const rows = new Map([
    [
      12345,
      {
        pid: 12345,
        parent: 1,
        group: 12345,
        state: 'S',
        started: 'replacement start',
      },
    ],
  ]);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  expect(fixtureGroupIsLive(group, rows)).toBe(false);
  signalFixtureGroup(group, 'SIGKILL', rows);
  expect(kill).not.toHaveBeenCalled();
});

it('rejects a detached group when its originating command is already a zombie', () => {
  const rows = inspectFixtureProcesses();
  rows.set(2_000_001, {
    pid: 2_000_001,
    parent: process.pid,
    group: 2_000_001,
    state: 'Z',
    started: 'origin',
  });
  rows.set(2_000_002, {
    pid: 2_000_002,
    parent: 2_000_001,
    group: 2_000_002,
    state: 'S',
    started: 'descendant',
  });
  expect(() =>
    validateDetachedFixtureGroup(2_000_002, new Set([2_000_001]), rows)
  ).toThrow('active fixture command');
});

it.each([
  { launch: 'missing' },
  { launch: 'corrupt' },
  { readiness: 'missing' },
  { readiness: 'corrupt' },
  { readiness: 'mismatched' },
  { producerFailure: true },
  {
    beforeRegister: () => {
      throw new Error('injected registration failure');
    },
  },
] satisfies ScenarioOptions[])(
  'cleans the scenario scope when setup fails: %j',
  { timeout: 15_000 },
  async (options) => {
    const fixture = makeFixture();
    await expect(scenario(fixture, true, 10_000, options)).rejects.toThrow();
    const observed = JSON.parse(
      fs.readFileSync(path.join(fixture.support, 'observed.json'), 'utf8')
    ) as { pid: number; parent: number };
    await expect
      .poll(() => stopped(observed.pid), { timeout: 5_000 })
      .toBe(true);
    expect(stopped(observed.parent)).toBe(true);
    await disposeWorkflowFixture(fixture);
    expect(fs.existsSync(fixture.root)).toBe(false);
  }
);

it(
  'owns delayed bootstrap and test-body failures before cleanup',
  { timeout: 15_000 },
  async () => {
    const fixture = makeFixture();
    const child = await scenario(fixture, true, 10_000, {
      bootstrapDelayMs: 250,
    });
    try {
      expect(() => {
        throw new Error('test-body failure');
      }).toThrow('test-body failure');
    } finally {
      await child.dispose();
    }
    expect(stopped(child.pid)).toBe(true);
  }
);

it(
  'rejects duplicate registration immediately after cancellation begins',
  { timeout: 15_000 },
  async () => {
    const child = await scenario(makeFixture(), true);
    const fixture = fixtures.at(-1)!;
    child.cancel.abort('start cleaning');
    await expect(
      registerFixtureProcessGroup(fixture, child.pid)
    ).rejects.toThrow('no longer running');
    await child.running;
  }
);

it('attempts valid fixture cleanup after a synchronous collection error', async () => {
  const fixture = makeFixture();
  const unknown = { root: '/not-owned' } as WorkflowFixture;
  const collection = [unknown, fixture];
  const restore = vi.fn();
  await expect(disposeWorkflowFixtures(collection, restore)).rejects.toThrow(
    'collection'
  );
  expect(collection).toEqual([unknown]);
  expect(fs.existsSync(fixture.root)).toBe(false);
  expect(restore).toHaveBeenCalledOnce();
});

it.each(['missing leader', 'stopped', 'same identity contradiction'])(
  'handles synthetic group snapshot: %s without host signaling',
  (mode) => {
    const group = { pid: 2_000_001, started: 'original' };
    const rows = new Map<
      number,
      {
        pid: number;
        parent: number;
        group: number;
        state: string;
        started: string;
      }
    >();
    if (mode !== 'stopped')
      rows.set(2_000_002, {
        pid: 2_000_002,
        parent: 1,
        group: group.pid,
        state: 'S',
        started: 'child',
      });
    if (mode === 'same identity contradiction')
      rows.set(group.pid, {
        pid: group.pid,
        parent: 1,
        group: 2_000_003,
        state: 'S',
        started: 'original',
      });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    if (mode === 'same identity contradiction') {
      expect(() => signalFixtureGroup(group, 'SIGKILL', rows)).toThrow(
        'leader'
      );
      expect(kill).not.toHaveBeenCalled();
    } else {
      expect(fixtureGroupIsLive(group, rows)).toBe(mode === 'missing leader');
      signalFixtureGroup(group, 'SIGTERM', rows);
      expect(kill).toHaveBeenCalledTimes(mode === 'missing leader' ? 1 : 0);
    }
  }
);

it(
  'disposes only the exact captured capability and permits idempotent cleanup',
  { timeout: 15_000 },
  async () => {
    const child = await scenario(makeFixture(), true);
    const capability = child.capability!;
    try {
      await expect(
        disposeCapturedFixtureProcessGroup({ ...capability })
      ).rejects.toThrow('Unknown');
      await disposeCapturedFixtureProcessGroup(capability);
      await disposeCapturedFixtureProcessGroup(capability);
      expect(stopped(child.pid)).toBe(true);
    } finally {
      await child.dispose();
    }
  }
);

it(
  'retains unconfirmed readiness-failure cleanup until explicit recovery and acknowledgement',
  { timeout: 15_000 },
  async () => {
    const fixture = makeFixture();
    const original = childProcess.spawnSync;
    const inspect = vi.spyOn(childProcess, 'spawnSync');
    const scope = createFixtureScenario(fixture, {
      readiness: 'corrupt',
      afterOwnership: () => {
        inspect.mockImplementation((...args: Parameters<typeof original>) => {
          if (args[0] === '/bin/ps')
            throw new Error('startup cleanup inspection failure');
          return original(...args);
        });
        syncBuiltinESMExports();
      },
    });
    scenarios.push(scope);
    let result: Awaited<ReturnType<typeof runFixtureCommand>> | undefined;
    try {
      await expect(scope.start()).rejects.toThrow('setup and cleanup failed');
      result = await scope.running;
      expect(result?.error?.message).toContain(
        'startup cleanup inspection failure'
      );
      await expect(disposeWorkflowFixture(fixture)).rejects.toThrow('retained');
      expect(fs.existsSync(fixture.root)).toBe(true);
    } finally {
      inspect.mockRestore();
      syncBuiltinESMExports();
      await expect(disposeWorkflowFixture(fixture)).rejects.toThrow('retained');
      for (const failure of result?.cleanupFailures ?? []) {
        if (failure.kind === 'output-drain-unconfirmed')
          acknowledgeFixtureCleanupFailure(fixture, failure, {
            reason:
              'Startup groups verified stopped; lost pipe evidence explicitly accepted',
          });
      }
      await scope.dispose();
      await disposeWorkflowFixture(fixture);
    }
    expect(
      result?.cleanupFailures.some(
        (failure) => failure.kind === 'output-drain-unconfirmed'
      )
    ).toBe(true);
    expect(result?.error?.message).toContain(
      'startup cleanup inspection failure'
    );
  }
);
