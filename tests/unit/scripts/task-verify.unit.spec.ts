import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  publishFailure: false,
  staging: '',
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async mkdtemp(prefix: string) {
      const directory = await actual.mkdtemp(prefix);
      if (prefix.includes('selective-designer-verification-'))
        mocks.staging = directory;
      return directory;
    },
    async cp(...args: Parameters<typeof actual.cp>) {
      if (mocks.publishFailure) throw new Error('Publication denied');
      return actual.cp(...args);
    },
  };
});
let root: string | undefined;
let previousExitCode: typeof process.exitCode;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = previousExitCode;
  if (root) await rm(root, { recursive: true, force: true });
  if (mocks.staging) await rm(mocks.staging, { recursive: true, force: true });
});
async function run(failureAt?: number, publicationFailure = false) {
  vi.resetModules();
  mocks.spawn.mockReset();
  mocks.publishFailure = publicationFailure;
  mocks.staging = '';
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
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
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const current = count++;
    setImmediate(() => {
      void (async () => {
        child.stdout.emit('data', 'before cleanup\n');
        await rm(output, { recursive: true, force: true });
        child.stderr.emit('data', 'after cleanup\n');
        child.emit('close', current === failureAt ? 2 : 0, null);
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
