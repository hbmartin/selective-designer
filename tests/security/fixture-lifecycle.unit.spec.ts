import {
  createWorkflowFixture,
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
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, assert, expect, it, vi } from 'vitest';

const fixtures: WorkflowFixture[] = [];
const makeFixture = () => {
  const fixture = createWorkflowFixture();
  fixtures.push(fixture);
  return fixture;
};
afterEach(async () => {
  await disposeWorkflowFixtures(fixtures, () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    syncBuiltinESMExports();
  });
});
function stopped(pid: number) {
  const row = inspectFixtureProcesses().get(pid);
  return !row || row.state.startsWith('Z');
}
async function scenario(
  fixture: WorkflowFixture,
  detached: boolean,
  timeoutMs = 10_000
) {
  const ready = path.join(fixture.support, 'ready.json');
  const release = path.join(fixture.support, 'release');
  const descendant = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);const fs=require('node:fs');fs.writeSync(1,'descendant stdout\\n');fs.writeSync(2,'descendant stderr\\n');fs.writeFileSync(${JSON.stringify(ready + '.tmp')},JSON.stringify({pid:process.pid,parent:process.ppid}));fs.renameSync(${JSON.stringify(ready + '.tmp')},${JSON.stringify(ready)});`;
  const leader = `process.on('SIGTERM',()=>{});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:${detached},stdio:['ignore','inherit','inherit']}).unref();setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(release)}))process.exit(0)},20);`;
  const cancel = new AbortController();
  const running = runFixtureCommand(process.execPath, ['-e', leader], fixture, {
    signal: cancel.signal,
    timeoutMs,
  });
  await expect.poll(() => fs.existsSync(ready), { timeout: 5_000 }).toBe(true);
  const ids = JSON.parse(fs.readFileSync(ready, 'utf8')) as {
    pid: number;
    parent: number;
  };
  return { ...ids, cancel, running, release };
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
      if (!stopped(child.pid)) process.kill(-child.pid, 'SIGKILL');
      await child.running;
    }
  }
);

it(
  'bounds inherited pipes from an unregistered daemon and reports incomplete cleanup',
  { timeout: 15_000 },
  async () => {
    const fixture = makeFixture();
    const child = await scenario(fixture, true);
    try {
      fs.writeFileSync(child.release, 'exit');
      await expect
        .poll(() => stopped(child.parent), { timeout: 5_000 })
        .toBe(true);
      await expect(
        registerFixtureProcessGroup(fixture, child.pid)
      ).rejects.toThrow('active fixture command');
      const result = await child.running;
      expect(result.status).toBe(0);
      expect(result.cleanupError?.message).toContain(
        'unregistered daemonization'
      );
      expect(result.stdout).toContain('descendant stdout');
      expect(stopped(child.pid)).toBe(false);
    } finally {
      process.kill(-child.pid, 'SIGKILL');
      await child.running;
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
      process.kill(-unrelated.pid, 'SIGKILL');
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
      await disposeWorkflowFixture(fixture);
      await child.running;
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
  const kill = vi.spyOn(process, 'kill');
  expect(() => fixtureGroupIsLive(group, rows)).toThrow('changed identity');
  expect(() => signalFixtureGroup(group, 'SIGKILL', rows)).toThrow(
    'changed identity'
  );
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
