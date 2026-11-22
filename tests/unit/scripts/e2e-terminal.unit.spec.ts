import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createE2ETerminal } from '@tests/server/e2e-terminal';
let previousExitCode: typeof process.exitCode;
beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = previousExitCode;
});
it('reports once without changing status, then marks terminal failure without repeating it', () => {
  const terminal = createE2ETerminal();
  const failure = new Error('Cleanup failure');
  process.exitCode = 7;
  terminal.report(failure, 'E2E cleanup failed');
  expect(process.exitCode).toBe(7);
  expect(terminal.active).toBe(false);
  terminal.fail(failure, 'E2E cleanup failed');
  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    'E2E cleanup failed: Cleanup failure'
  );
});
it('deduplicates original errors retained in an aggregate', () => {
  const terminal = createE2ETerminal();
  const first = new Error('First');
  const second = new Error('Second');
  terminal.report(first, 'Cleanup');
  terminal.report(new AggregateError([first, second]), 'Cleanup');
  expect(vi.mocked(console.error).mock.calls).toEqual([
    ['Cleanup: First'],
    ['Cleanup: Second'],
  ]);
});
it('warns and attempts flushing at nine seconds without changing a successful status', async () => {
  const terminal = createE2ETerminal();
  const stdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);
  terminal.begin();
  await vi.advanceTimersByTimeAsync(9000);
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('pending after nine seconds')
  );
  expect(stdout).toHaveBeenCalled();
  expect(stderr).toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
  expect(process.exit).not.toHaveBeenCalled();
});
it('does not extend the hard stop for repeated begin calls or a stalled output consumer', async () => {
  const terminal = createE2ETerminal();
  const forceStop = vi.fn();
  terminal.setForceStop(forceStop);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  void terminal.finish();
  await vi.advanceTimersByTimeAsync(9000);
  terminal.begin();
  await vi.advanceTimersByTimeAsync(999);
  expect(process.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(forceStop).toHaveBeenCalledOnce();
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
});
