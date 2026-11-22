import { beforeEach, expect, it, vi } from 'vitest';
import { inspectFixtureProcesses } from '@tests/support/fixture-process-snapshot.mjs';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawn }));
beforeEach(() => {
  vi.resetAllMocks();
});
it('retains the original execution error and the existing per-attempt limit', () => {
  const failure = Object.assign(new Error('ps timeout'), { code: 'ETIMEDOUT' });
  mocks.spawn.mockReturnValue({
    error: failure,
    status: null,
    stderr: '',
    stdout: '',
  });
  expect(() => inspectFixtureProcesses(5000)).toThrow(
    expect.objectContaining({ cause: failure })
  );
  expect(mocks.spawn).toHaveBeenCalledWith(
    '/bin/ps',
    expect.any(Array),
    expect.objectContaining({ timeout: 500 })
  );
});
it('does not classify malformed snapshots as transient execution failures', () => {
  mocks.spawn.mockReturnValue({ status: 0, stderr: '', stdout: 'malformed' });
  expect(() => inspectFixtureProcesses()).toThrow(
    'Invalid fixture process inspection row'
  );
});
