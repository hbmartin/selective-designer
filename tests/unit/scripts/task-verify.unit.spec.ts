import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  publishFailure: false,
  staging: '',
  publishWait: undefined as Promise<void> | undefined,
  publishEntered: undefined as (() => void) | undefined,
  logFailure: false,
  logOpenFailure: false,
  partialSummaryFailure: false,
  summaryFailure: false,
  copyFailureName: undefined as string | undefined,
  removalFailure: false,
  recoveryAllocationFailure: false,
  recoveryDirectory: '',
  recoveryAllocations: 0,
  permissionFailure: false,
  permissionWait: undefined as Promise<void> | undefined,
  permissionEntered: undefined as (() => void) | undefined,
  cleanupFailure: undefined as 'inspect' | 'remove' | undefined,
  cleanupWait: undefined as Promise<void> | undefined,
  cleanupEntered: undefined as (() => void) | undefined,
  copies: [] as string[],
  copyAction: undefined as
    | ((source: string, destination: string) => Promise<void> | undefined)
    | undefined,
  removals: [] as string[],
  summaryWrites: [] as { name: string; text: string }[],
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream(...args: Parameters<typeof actual.createWriteStream>) {
      if (mocks.logOpenFailure) throw new Error('Log creation rejected');
      if (mocks.logFailure)
        return new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error('Log write rejected'));
          },
        });
      return actual.createWriteStream(...args);
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async mkdtemp(prefix: string) {
      if (prefix.includes('-incomplete-')) {
        mocks.recoveryAllocations++;
        if (mocks.recoveryAllocationFailure)
          throw new Error('Recovery allocation denied');
      }
      const directory = await actual.mkdtemp(prefix);
      if (prefix.includes('selective-designer-verification-'))
        mocks.staging = directory;
      if (prefix.includes('-incomplete-')) mocks.recoveryDirectory = directory;
      return directory;
    },
    async chmod(...args: Parameters<typeof actual.chmod>) {
      mocks.permissionEntered?.();
      await mocks.permissionWait;
      if (mocks.permissionFailure)
        throw new Error('Recovery permissions denied');
      return actual.chmod(...args);
    },
    async readdir(...args: Parameters<typeof actual.readdir>) {
      if (String(args[0]) === mocks.recoveryDirectory) {
        mocks.cleanupEntered?.();
        await mocks.cleanupWait;
        if (mocks.cleanupFailure === 'inspect')
          throw new Error('Recovery inspection denied');
      }
      return actual.readdir(...args);
    },
    async rmdir(...args: Parameters<typeof actual.rmdir>) {
      mocks.removals.push(String(args[0]));
      if (mocks.cleanupFailure === 'remove')
        throw new Error('Recovery removal denied');
      return actual.rmdir(...args);
    },
    async rm(...args: Parameters<typeof actual.rm>) {
      if (
        mocks.removalFailure &&
        path.basename(String(args[0])) === 'summary.md'
      )
        throw Object.assign(new Error('Stale summary removal denied'), {
          code: 'EACCES',
        });
      return actual.rm(...args);
    },
    cp(...args: Parameters<typeof actual.cp>) {
      mocks.copies.push(String(args[0]));
      const action = mocks.copyAction?.(String(args[0]), String(args[1]));
      if (action) return action;
      return (async () => {
        mocks.publishEntered?.();
        await mocks.publishWait;
        if (mocks.publishFailure) throw new Error('Publication denied');
        if (
          mocks.copyFailureName &&
          (args[0] === mocks.staging ||
            path.basename(String(args[0])) === mocks.copyFailureName)
        )
          throw new Error('Controlled artifact copy failure');
        return actual.cp(...args);
      })();
    },
    async writeFile(...args: Parameters<typeof actual.writeFile>) {
      const name = path.basename(String(args[0]));
      mocks.summaryWrites.push({ name, text: String(args[1]) });
      if (
        (name === 'summary.md' && mocks.summaryFailure) ||
        (name === 'partial-summary.md' && mocks.partialSummaryFailure)
      ) {
        // A failed write may leave a stale/partial summary behind.
        await actual.writeFile(args[0], 'Status: passed\n');
        throw new Error('Summary write rejected');
      }
      return actual.writeFile(...args);
    },
  };
});
let root: string | undefined;
let previousExitCode: typeof process.exitCode;
afterEach(async () => {
  vi.restoreAllMocks();
  mocks.publishWait = undefined;
  mocks.publishEntered = undefined;
  mocks.logFailure = false;
  mocks.logOpenFailure = false;
  mocks.partialSummaryFailure = false;
  mocks.summaryFailure = false;
  mocks.copyFailureName = undefined;
  mocks.removalFailure = false;
  mocks.recoveryAllocationFailure = false;
  mocks.recoveryDirectory = '';
  mocks.recoveryAllocations = 0;
  mocks.permissionFailure = false;
  mocks.permissionWait = undefined;
  mocks.permissionEntered = undefined;
  mocks.cleanupFailure = undefined;
  mocks.cleanupWait = undefined;
  mocks.cleanupEntered = undefined;
  mocks.copies = [];
  mocks.copyAction = undefined;
  mocks.removals = [];
  mocks.summaryWrites = [];
  vi.unstubAllEnvs();
  process.exitCode = previousExitCode;
  if (root) await rm(root, { recursive: true, force: true });
  if (mocks.staging) await rm(mocks.staging, { recursive: true, force: true });
});
async function run(
  failureAt?: number,
  publicationFailure = false,
  options: {
    signal?: 'SIGINT' | 'SIGTERM';
    afterClose?: boolean;
    repeat?: boolean;
    hold?: Promise<void>;
    entered?: () => void;
    initialStatus?: number;
    spawnFailure?: boolean;
    syncSpawnFailure?: boolean;
  } = {}
) {
  vi.resetModules();
  mocks.spawn.mockReset();
  mocks.publishFailure = publicationFailure;
  mocks.staging = '';
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  if (options.initialStatus) process.exitCode = options.initialStatus;
  vi.stubEnv('CI', 'true');
  root = await mkdtemp(path.join(os.tmpdir(), 'task-verify-test-'));
  const output = path.join(root, 'test-results');
  await mkdir(output);
  const resolve = path.resolve.bind(path);
  vi.spyOn(path, 'resolve').mockImplementation((...segments) =>
    segments[0] === 'test-results'
      ? path.join(root!, ...segments)
      : resolve(...segments)
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  let count = 0;
  mocks.spawn.mockImplementation(() => {
    if (options.syncSpawnFailure) throw new Error('Synchronous spawn rejected');
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => true),
    });
    const current = count++;
    setImmediate(() => {
      void (async () => {
        if (options.spawnFailure) {
          child.emit('error', new Error('Command spawn rejected'));
          child.emit('close', 1, null);
          return;
        }
        child.stdout.emit('data', 'before cleanup\n');
        await rm(output, { recursive: true, force: true });
        function interrupt() {
          if (!options.signal) return;
          process.emit(options.signal);
          if (options.repeat)
            process.emit(options.signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
          options.entered?.();
        }
        if (!options.afterClose) interrupt();
        await options.hold;
        child.stderr.emit('data', 'after cleanup\n');
        child.emit(
          'close',
          current === failureAt ? 2 : options.signal ? null : 0,
          options.signal ?? null
        );
        if (options.afterClose) interrupt();
      })().catch((failure) => {
        child.emit('error', failure);
        child.emit('close', 1, null);
      });
    });
    return child;
  });
  await import('../../../scripts/task-verify.mjs');
  return { output, error };
}
it.each([undefined, 1])(
  'publishes complete logs after output deletion on failure=%s',
  async (failureAt) => {
    const { output } = await run(failureAt);
    const [report] = await readdir(path.join(output, 'task-verification'));
    const directory = path.join(output, 'task-verification', report!);
    const files = await readdir(directory);
    for (const file of files.filter((file) => file.endsWith('.log'))) {
      const text = await readFile(path.join(directory, file), 'utf8');
      expect(text).toContain('before cleanup');
      expect(text).toContain('after cleanup');
      expect(text).toContain('durationMs=');
    }
    expect(
      await readFile(path.join(directory, 'summary.md'), 'utf8')
    ).toContain(`Status: ${failureAt === undefined ? 'passed' : 'failed'}`);
    expect(process.exitCode).toBe(failureAt === undefined ? undefined : 2);
    expect(mocks.staging.startsWith(output)).toBe(false);
  }
);
it('retains staging and the command status when publication fails', async () => {
  const { error } = await run(0, true);
  expect(process.exitCode).toBe(2);
  expect(
    await readFile(path.join(mocks.staging, 'format-changed.log'), 'utf8')
  ).toContain('after cleanup');
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining(`retained ${mocks.staging}`),
    expect.any(Error)
  );
});

it.each(['SIGINT', 'SIGTERM'] as const)(
  'publishes an interrupted report after %s and joins repeated signals',
  async (signal) => {
    await run(undefined, false, { signal, repeat: true });
    const [report] = await readdir(
      path.join(root!, 'test-results', 'task-verification')
    );
    const directory = path.join(
      root!,
      'test-results',
      'task-verification',
      report!
    );
    expect(
      await readFile(path.join(directory, 'summary.md'), 'utf8')
    ).toContain('Status: interrupted');
    expect(
      await readFile(path.join(directory, 'format-changed.log'), 'utf8')
    ).toContain('after cleanup');
    expect(mocks.spawn).toHaveBeenCalledOnce();
    const child = mocks.spawn.mock.results[0]!.value;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith(signal);
    expect(process.exitCode).toBe(signal === 'SIGINT' ? 130 : 143);
  }
);

it('preserves a genuine step failure observed before interruption', async () => {
  const { output } = await run(0, false, {
    signal: 'SIGINT',
    afterClose: true,
  });
  expect(process.exitCode).toBe(2);
  const [report] = await readdir(path.join(output, 'task-verification'));
  const summary = await readFile(
    path.join(output, 'task-verification', report!, 'summary.md'),
    'utf8'
  );
  expect(summary).toContain('Status: failed');
  expect(summary).toContain('Interrupted: SIGINT');
});

it('does not announce a published report after copy failure', async () => {
  await run(undefined, true, { signal: 'SIGTERM' });
  expect(console.log).not.toHaveBeenCalledWith(
    expect.stringContaining('Verification report:')
  );
  expect(process.exitCode).toBe(143);
  expect(
    await readFile(path.join(mocks.staging, 'summary.md'), 'utf8')
  ).toContain('Status: interrupted');
});

it('bounds interruption when a child keeps output open without extending the deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation(() => undefined as never);
  const entered = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<void>();
  try {
    const running = run(undefined, false, {
      signal: 'SIGINT',
      entered: entered.resolve,
      hold: hold.promise,
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(9000);
    process.emit('SIGTERM');
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(130);
    expect(mocks.spawn.mock.results[0]!.value.kill).toHaveBeenLastCalledWith(
      'SIGKILL'
    );
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Verification report:')
    );
    hold.resolve();
    await running;
  } finally {
    hold.resolve();
    vi.useRealTimers();
  }
});

it('waits for successful publication before announcing the report', async () => {
  const publish = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  mocks.publishWait = publish.promise;
  mocks.publishEntered = entered.resolve;
  const running = run();
  await entered.promise;
  expect(console.log).not.toHaveBeenCalledWith(
    expect.stringContaining('Verification report:')
  );
  publish.resolve();
  await running;
  expect(console.log).toHaveBeenCalledWith(
    expect.stringContaining('Verification report:')
  );
});

it('includes interruption received while publication is in progress', async () => {
  let copies = 0;
  mocks.publishEntered = () => {
    if (++copies === 1) process.emit('SIGINT');
  };
  await run();
  const [report] = await readdir(
    path.join(root!, 'test-results', 'task-verification')
  );
  expect(
    await readFile(
      path.join(
        root!,
        'test-results',
        'task-verification',
        report!,
        'summary.md'
      ),
      'utf8'
    )
  ).toContain('Status: interrupted');
  expect(copies).toBe(2);
  expect(process.exitCode).toBe(130);
});

it.each(['spawn', 'log'] as const)(
  'retains evidence after a %s failure and starts no next step',
  async (failure) => {
    mocks.logFailure = failure === 'log';
    await run(undefined, false, { spawnFailure: failure === 'spawn' });
    expect(process.exitCode).toBe(1);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalled();
  }
);

it('bounds a stalled publication and retains staging without announcing success', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation(() => undefined as never);
  const publish = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  mocks.publishWait = publish.promise;
  mocks.publishEntered = entered.resolve;
  try {
    const running = run(undefined, false, { signal: 'SIGTERM' });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(143);
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Verification report:')
    );
    publish.resolve();
    await running;
    expect(
      await readFile(path.join(mocks.staging, 'summary.md'), 'utf8')
    ).toContain('Status: interrupted');
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Verification report:')
    );
  } finally {
    publish.resolve();
    vi.useRealTimers();
  }
});

async function reportDirectory(output: string) {
  const reports = await readdir(path.join(output, 'task-verification'));
  const report = reports.find((name) => !name.includes('-incomplete-'));
  return path.join(output, 'task-verification', report!);
}
it('publishes a failed attempt and diagnostic after a log rejection despite child exit zero', async () => {
  mocks.logFailure = true;
  const { output } = await run();
  const directory = await reportDirectory(output);
  const summary = await readFile(path.join(directory, 'summary.md'), 'utf8');
  expect(summary).toContain('Status: failed');
  expect(summary).toContain('FAIL `pnpm format:changed`');
  expect(summary).toContain('Diagnostic: Log write rejected');
  expect(summary).toContain('Exit: 0');
  expect(process.exitCode).toBe(1);
  expect(mocks.spawn).toHaveBeenCalledOnce();
});
it.each(['spawn', 'log-open'] as const)(
  'records an attempted step before synchronous %s failure',
  async (kind) => {
    mocks.logOpenFailure = kind === 'log-open';
    const { output } = await run(undefined, false, {
      syncSpawnFailure: kind === 'spawn',
    });
    const summary = await readFile(
      path.join(await reportDirectory(output), 'summary.md'),
      'utf8'
    );
    expect(summary).toContain('FAIL `pnpm format:changed`');
    expect(summary).toContain(
      kind === 'spawn' ? 'Synchronous spawn rejected' : 'Log creation rejected'
    );
    expect(summary).toContain('Status: failed');
    expect(mocks.spawn).toHaveBeenCalledTimes(kind === 'spawn' ? 1 : 0);
    expect(process.exitCode).toBe(1);
  }
);
it('publishes final evidence after an initial partial summary write rejects', async () => {
  mocks.partialSummaryFailure = true;
  const { output } = await run(undefined, false, { signal: 'SIGTERM' });
  const directory = await reportDirectory(output);
  expect(await readFile(path.join(directory, 'summary.md'), 'utf8')).toContain(
    'Status: interrupted'
  );
  expect(
    await readFile(path.join(directory, 'format-changed.log'), 'utf8')
  ).toContain('after cleanup');
  expect(console.error).toHaveBeenCalledWith(
    'Verification partial summary failed:',
    expect.any(Error)
  );
  expect(process.exitCode).toBe(143);
});
it.each([undefined, 'SIGTERM'] as const)(
  'publishes incomplete logs and retains staging when the final summary fails: signal=%s',
  async (signal) => {
    mocks.summaryFailure = true;
    const { output } = await run(undefined, false, { signal });
    const directory = await reportDirectory(output);
    expect(
      await readFile(path.join(directory, 'format-changed.log'), 'utf8')
    ).toContain('after cleanup');
    expect(await readdir(directory)).not.toContain('summary.md');
    expect(await readdir(mocks.staging)).toContain('format-changed.log');
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Verification report:')
    );
    expect(console.error).toHaveBeenCalledWith(
      `Incomplete verification artifacts: ${directory}; retained staging: ${mocks.staging}`
    );
    expect(process.exitCode).toBe(signal ? 143 : 1);
  }
);
it('removes an earlier copied summary when interruption makes the final revision unwritable', async () => {
  let copies = 0;
  mocks.publishEntered = () => {
    if (++copies === 1) {
      mocks.summaryFailure = true;
      process.emit('SIGINT');
    }
  };
  const { output } = await run();
  const directory = await reportDirectory(output);
  expect(await readdir(directory)).not.toContain('summary.md');
  expect(await readFile(path.join(directory, 'test.log'), 'utf8')).toContain(
    'after cleanup'
  );
  expect(console.log).not.toHaveBeenCalledWith(
    expect.stringContaining('Verification report:')
  );
  expect(process.exitCode).toBe(130);
});
it('copies remaining readable logs when one artifact fails and retains the incomplete staging', async () => {
  mocks.copyFailureName = 'check-ci.log';
  const { output } = await run();
  const directory = await reportDirectory(output);
  const files = await readdir(directory);
  expect(files).toContain('format-changed.log');
  expect(files).toContain('test.log');
  expect(files).not.toContain('summary.md');
  expect(await readdir(mocks.staging)).toContain('check-ci.log');
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('Incomplete verification artifacts:')
  );
  expect(process.exitCode).toBe(1);
});

it.each(['before-copy', 'after-copy'] as const)(
  'publishes readable logs to one fresh directory after %s summary-removal failure',
  async (stage) => {
    mocks.removalFailure = true;
    mocks.summaryFailure = stage === 'before-copy';
    if (stage === 'after-copy') mocks.copyFailureName = 'check-ci.log';
    const { output } = await run();
    const original = await reportDirectory(output);
    expect(mocks.recoveryAllocations).toBe(1);
    expect(mocks.recoveryDirectory).not.toBe(original);
    expect(path.dirname(mocks.recoveryDirectory)).toBe(path.dirname(original));
    const files = await readdir(mocks.recoveryDirectory);
    expect(files).toContain('format-changed.log');
    expect(files).toContain('test.log');
    expect(files).not.toContain('summary.md');
    expect(files).not.toContain('partial-summary.md');
    expect(await readdir(mocks.staging)).toContain('format-changed.log');
    expect(console.error).toHaveBeenCalledWith(
      `Stale/untrusted verification destination: ${path.join(original, 'summary.md')}`
    );
    expect(console.error).toHaveBeenCalledWith(
      `Incomplete verification artifacts: ${mocks.recoveryDirectory}; retained staging: ${mocks.staging}`
    );
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Verification report:')
    );
    expect(process.exitCode).toBe(1);
  }
);
it('reports an undeletable earlier summary as untrusted without mixing recovery logs into it', async () => {
  let copies = 0;
  mocks.publishEntered = () => {
    if (++copies === 1) {
      mocks.summaryFailure = true;
      mocks.removalFailure = true;
      process.emit('SIGINT');
    }
  };
  const { output } = await run();
  const original = await reportDirectory(output);
  expect(await readFile(path.join(original, 'summary.md'), 'utf8')).toContain(
    'Status: passed'
  );
  expect(await readdir(mocks.recoveryDirectory)).not.toContain('summary.md');
  expect(
    await readFile(path.join(mocks.recoveryDirectory, 'test.log'), 'utf8')
  ).toContain('after cleanup');
  expect(console.error).toHaveBeenCalledWith(
    `Stale/untrusted verification destination: ${path.join(original, 'summary.md')}`
  );
  expect(console.log).not.toHaveBeenCalledWith(
    expect.stringContaining('Verification report:')
  );
  expect(process.exitCode).toBe(130);
});
it('retains staging and reports allocation failure once without retrying', async () => {
  mocks.summaryFailure = true;
  mocks.removalFailure = true;
  mocks.recoveryAllocationFailure = true;
  const { error } = await run();
  expect(mocks.recoveryAllocations).toBe(1);
  const reports = error.mock.calls.filter((call) =>
    String(call[0]).startsWith('Verification recovery allocation failed;')
  );
  expect(reports).toHaveLength(1);
  expect(await readdir(mocks.staging)).toContain('format-changed.log');
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('Verification artifacts remain unpublished;')
  );
  expect(console.log).not.toHaveBeenCalledWith(
    expect.stringContaining('Verification report:')
  );
  expect(process.exitCode).toBe(1);
});
it('keeps a failed fresh destination diagnostic-only when no copy succeeds', async () => {
  mocks.removalFailure = true;
  const { error } = await run(undefined, true);
  expect(mocks.recoveryAllocations).toBe(1);
  await expect(stat(mocks.recoveryDirectory)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(mocks.removals).toEqual([mocks.recoveryDirectory]);
  expect(error).not.toHaveBeenCalledWith(
    expect.stringContaining('Incomplete verification artifacts:')
  );
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining('Verification artifacts remain unpublished;')
  );
  const roots = error.mock.calls.filter((call) =>
    String(call[0]).startsWith('Verification publication failed;')
  );
  expect(roots).toHaveLength(1);
  expect(
    error.mock.calls.filter((call) => call[1] === roots[0]![1])
  ).toHaveLength(1);
  const copies = error.mock.calls.filter((call) =>
    String(call[0]).startsWith('Verification artifact copy failed;')
  );
  expect(copies).toHaveLength(3);
  expect(new Set(copies.map((call) => call[1])).size).toBe(3);
});
it('publishes only the final summary and formats pending duration without units', async () => {
  const { output } = await run(undefined, false, { signal: 'SIGINT' });
  const directory = await reportDirectory(output);
  expect(await readdir(directory)).toContain('summary.md');
  expect(await readdir(directory)).not.toContain('partial-summary.md');
  const partial = mocks.summaryWrites.find(
    (entry) => entry.name === 'partial-summary.md'
  )!.text;
  expect(partial).toContain('Duration: pending\n');
  expect(partial).not.toContain('pendingms');
  expect(await readFile(path.join(directory, 'summary.md'), 'utf8')).toMatch(
    /Duration: \d+ms/
  );
});
it('keeps one interruption deadline through a stalled fresh recovery copy', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation(() => undefined as never);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  mocks.publishWait = gate.promise;
  mocks.publishEntered = entered.resolve;
  mocks.summaryFailure = true;
  mocks.removalFailure = true;
  try {
    const running = run(undefined, false, { signal: 'SIGTERM' });
    await entered.promise;
    expect(mocks.recoveryAllocations).toBe(1);
    await vi.advanceTimersByTimeAsync(9000);
    process.emit('SIGINT');
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(143);
    gate.resolve();
    await running;
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Verification report:')
    );
    expect(process.exitCode).toBe(143);
    expect(await readdir(mocks.staging)).toContain('format-changed.log');
  } finally {
    gate.resolve();
    vi.useRealTimers();
  }
});

it.skipIf(process.platform === 'win32').each([0o022, 0o077])(
  'matches ordinary report permissions under umask %s while keeping staging private',
  async (mask) => {
    const previous = process.umask(mask);
    mocks.summaryFailure = true;
    mocks.removalFailure = true;
    try {
      const { output } = await run();
      expect((await stat(await reportDirectory(output))).mode & 0o777).toBe(
        0o777 & ~mask
      );
      expect((await stat(mocks.recoveryDirectory)).mode & 0o777).toBe(
        0o777 & ~mask
      );
      expect((await stat(mocks.staging)).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previous);
    }
  }
);
it('retains staging on a permission failure before copying and removes only its empty allocation', async () => {
  mocks.summaryFailure = true;
  mocks.removalFailure = true;
  mocks.permissionFailure = true;
  const { error } = await run();
  expect(mocks.copies).toEqual([]);
  expect(mocks.recoveryAllocations).toBe(1);
  expect(mocks.removals).toEqual([mocks.recoveryDirectory]);
  await expect(stat(mocks.recoveryDirectory)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readdir(mocks.staging)).toContain('format-changed.log');
  expect(
    error.mock.calls.filter(
      (call) =>
        call[1] instanceof Error &&
        call[1].message === 'Recovery permissions denied'
    )
  ).toHaveLength(1);
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining('Verification artifacts remain unpublished;')
  );
  expect(process.exitCode).toBe(1);
});
it('catches an unexpected recovery rejection without attempting recovery twice', async () => {
  mocks.summaryFailure = true;
  mocks.removalFailure = true;
  mocks.copyFailureName = 'check-ci.log';
  const unexpected = new Error('Unexpected recovery rejection');
  let entered = false;
  mocks.publishEntered = () => {
    if (entered) return;
    entered = true;
    vi.mocked(console.error).mockImplementationOnce(() => {
      throw unexpected;
    });
  };
  const { error } = await run();
  expect(mocks.recoveryAllocations).toBe(1);
  expect(mocks.copies.map((name) => path.basename(name))).toEqual([
    'check-ci.log',
    'format-changed.log',
    'test.log',
  ]);
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining('Verification recovery failed;'),
    unexpected
  );
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining('Verification artifacts remain unpublished;')
  );
  expect(console.log).not.toHaveBeenCalledWith(
    expect.stringContaining('Verification report:')
  );
  expect(await readdir(mocks.staging)).toContain('format-changed.log');
});
it('starts and drains sibling copies even when a copy throws synchronously', async () => {
  mocks.summaryFailure = true;
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises'
    );
  mocks.copyAction = (source, destination) => {
    if (path.basename(source) === 'check-ci.log')
      throw new Error('Synchronous copy rejected');
    if (mocks.copies.length === 3) entered.resolve();
    return gate.promise.then(() => actual.cp(source, destination));
  };
  let settled = false;
  const running = run().finally(() => {
    settled = true;
  });
  try {
    await entered.promise;
    expect(mocks.copies).toHaveLength(3);
    expect(settled).toBe(false);
  } finally {
    gate.resolve();
  }
  const { output } = await running;
  const files = await readdir(await reportDirectory(output));
  expect(files).toEqual(['format-changed.log', 'test.log']);
  expect(process.exitCode).toBe(1);
});
it('preserves partial data even when every copy rejects', async () => {
  mocks.summaryFailure = true;
  mocks.removalFailure = true;
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises'
    );
  mocks.copyAction = async (_source, destination) => {
    await actual.writeFile(destination, 'partial evidence');
    throw new Error('Copy failed after writing');
  };
  await run();
  expect(await readdir(mocks.recoveryDirectory)).toHaveLength(3);
  expect(mocks.removals).toEqual([]);
  expect(
    await readFile(path.join(mocks.recoveryDirectory, 'test.log'), 'utf8')
  ).toBe('partial evidence');
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining(`attempted destination: ${mocks.recoveryDirectory}`)
  );
});
it.each(['inspect', 'remove'] as const)(
  'preserves uncertain recovery evidence after %s failure',
  async (failure) => {
    mocks.removalFailure = true;
    mocks.cleanupFailure = failure;
    const { error } = await run(undefined, true);
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises'
      );
    expect(await actual.readdir(mocks.recoveryDirectory)).toEqual([]);
    expect(
      error.mock.calls.filter((call) =>
        String(call[0]).startsWith('Verification recovery cleanup failed;')
      )
    ).toHaveLength(1);
    expect(await readdir(mocks.staging)).toContain('test.log');
  }
);
it('keeps a later valid summary staged once the destination is stale', async () => {
  mocks.summaryFailure = true;
  mocks.removalFailure = true;
  let copies = 0;
  mocks.publishEntered = () => {
    if (++copies === 1) {
      mocks.summaryFailure = false;
      process.emit('SIGINT');
    }
  };
  const { output } = await run();
  expect(mocks.recoveryAllocations).toBe(1);
  expect(mocks.copies).toHaveLength(6);
  expect(mocks.removals).toEqual([]);
  expect(
    await readFile(path.join(mocks.staging, 'summary.md'), 'utf8')
  ).toContain('Interrupted: SIGINT');
  expect(await readdir(mocks.recoveryDirectory)).toEqual([
    'check-ci.log',
    'format-changed.log',
    'test.log',
  ]);
  expect(await readdir(await reportDirectory(output))).not.toContain(
    'summary.md'
  );
  expect(console.error).toHaveBeenCalledWith(
    `Incomplete verification artifacts: ${mocks.recoveryDirectory}; retained staging: ${mocks.staging}`
  );
  expect(process.exitCode).toBe(1);
});
it('reuses the allocation through interruption and removes it only after the final revision', async () => {
  mocks.summaryFailure = true;
  mocks.removalFailure = true;
  let copies = 0;
  mocks.publishEntered = () => {
    expect(mocks.removals).toEqual([]);
    if (++copies === 1) process.emit('SIGINT');
  };
  await run(undefined, true);
  expect(mocks.recoveryAllocations).toBe(1);
  expect(mocks.copies).toHaveLength(6); // Three recovery copies for each publication revision.
  expect(mocks.removals).toEqual([mocks.recoveryDirectory]);
  await expect(stat(mocks.recoveryDirectory)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it('joins interruption during accepted-outcome housekeeping without restarting publication', async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  mocks.summaryFailure = true;
  mocks.removalFailure = true;
  mocks.cleanupWait = gate.promise;
  mocks.cleanupEntered = entered.resolve;
  const running = run(undefined, true);
  try {
    await entered.promise;
    process.emit('SIGINT');
    process.emit('SIGTERM');
    expect(mocks.copies).toHaveLength(3);
  } finally {
    gate.resolve();
  }
  await running;
  expect(mocks.recoveryAllocations).toBe(1);
  expect(mocks.removals).toEqual([mocks.recoveryDirectory]);
  expect(mocks.copies).toHaveLength(3);
  expect(process.exitCode).toBe(1);
});
it.each(['permission', 'cleanup'] as const)(
  'retains the same interruption deadline through stalled recovery %s',
  async (stage) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    mocks.summaryFailure = true;
    mocks.removalFailure = true;
    if (stage === 'permission') {
      mocks.permissionWait = gate.promise;
      mocks.permissionEntered = entered.resolve;
    } else {
      mocks.cleanupWait = gate.promise;
      mocks.cleanupEntered = entered.resolve;
    }
    try {
      const running = run(undefined, true, { signal: 'SIGTERM' });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(9000);
      process.emit('SIGINT');
      await vi.advanceTimersByTimeAsync(1000);
      expect(exit).toHaveBeenCalledExactlyOnceWith(143);
      gate.resolve();
      await running;
      expect(mocks.removals).toEqual([]);
      expect(await readdir(mocks.staging)).toContain('format-changed.log');
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('Verification report:')
      );
    } finally {
      gate.resolve();
      vi.useRealTimers();
    }
  }
);
