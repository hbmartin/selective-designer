import { access } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { launchE2EFixture } from '@tests/support/e2e-fixture-process';
import { inspectFixtureProcesses } from '@tests/support/fixture-process-groups';

const inspection = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('@tests/support/fixture-process-groups', async (original) => {
  const actual =
    await original<typeof import('@tests/support/fixture-process-groups')>();
  return { ...actual, inspectFixtureProcesses: inspection.inspect };
});
const actual = await vi.importActual<
  typeof import('@tests/support/fixture-process-groups')
>('@tests/support/fixture-process-groups');
afterEach(() => inspection.inspect.mockReset());

it('keeps retrying bootstrap resource-free until exhaustion, then removes its retained child', async () => {
  const failure = new Error('Controlled inspection execution timeout', {
    cause: { code: 'ETIMEDOUT' },
  });
  const observedGroups = new Set<number>();
  inspection.inspect.mockImplementation(() => {
    const rows = actual.inspectFixtureProcesses();
    const leaders = [...rows.values()].filter(
      (row) => row.parent === process.pid && row.group === row.pid
    );
    expect(leaders).toHaveLength(1);
    const leader = leaders[0]!;
    observedGroups.add(leader.pid);
    expect(
      [...rows.values()].filter((row) => row.group === leader.pid)
    ).toHaveLength(1);
    throw failure;
  });
  await expect(launchE2EFixture('waiting')).rejects.toMatchObject({
    message: 'Fixture process-group confirmation timed out',
    cause: failure,
  });
  expect(inspection.inspect.mock.calls.length).toBeGreaterThan(1);
  expect(observedGroups.size).toBe(1);
  for (const pid of observedGroups)
    expect(actual.inspectFixtureProcesses().has(pid)).toBe(false);
}, 15_000);

it('preserves the leader after failed disposal inspection and later discovers its setup child', async () => {
  inspection.inspect.mockImplementation(actual.inspectFixtureProcesses);
  const fixture = await launchE2EFixture('waiting');
  try {
    await fixture.waitForOutput('Fixture setup waiting', 10_000);
    const members = [...actual.inspectFixtureProcesses().values()].filter(
      (row) => row.group === fixture.group.pid
    );
    const descendant = members.find((row) => row.pid !== fixture.group.pid)!;
    expect(descendant).toBeDefined();
    expect(fixture.group.members?.has(descendant.pid)).toBe(false);
    const failure = new Error('Controlled disposal ps failure');
    inspection.inspect.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(fixture.dispose()).rejects.toMatchObject({ cause: failure });
    expect(fixture.child.exitCode).toBeNull();
    expect(fixture.child.signalCode).toBeNull();
    expect(actual.inspectFixtureProcesses().get(descendant.pid)?.started).toBe(
      descendant.started
    );
    await expect(access(fixture.root)).resolves.toBeUndefined();
    await fixture.dispose();
    expect(inspectFixtureProcesses().get(descendant.pid)?.state ?? 'Z').toMatch(
      /^Z/
    );
    await expect(access(fixture.root)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    inspection.inspect.mockImplementation(actual.inspectFixtureProcesses);
    await fixture.dispose();
  }
}, 30_000);
