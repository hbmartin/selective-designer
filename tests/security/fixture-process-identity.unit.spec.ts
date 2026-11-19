import {
  fixtureGroupIsLive,
  signalFixtureGroup,
  type FixtureProcessGroup,
} from '@tests/support/fixture-process-groups';
import {
  parseFixtureProcessSnapshot,
  type ProcessRow,
} from '@tests/support/fixture-process-snapshot.mjs';
import { afterEach, expect, it, vi } from 'vitest';
const member = (
  pid: number,
  group: number,
  started = `birth-${pid}`,
  state = 'S'
): ProcessRow => ({ pid, parent: 1, group, started, state });
const snapshot = (...rows: ProcessRow[]) =>
  new Map(rows.map((row) => [row.pid, row]));
afterEach(() => vi.restoreAllMocks());
it('authenticates leaderless survivors and member rollover only with a continuous witness', () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const group: FixtureProcessGroup = {
    pid: 2_000_001,
    started: 'original',
    members: new Map([[2_000_002, 'birth-2000002']]),
  };
  expect(
    fixtureGroupIsLive(
      group,
      snapshot(member(2_000_002, group.pid), member(2_000_003, group.pid))
    )
  ).toBe(true);
  signalFixtureGroup(
    group,
    'SIGTERM',
    snapshot(member(2_000_003, group.pid), member(2_000_004, group.pid))
  );
  expect(kill).toHaveBeenCalledWith(-group.pid, 'SIGTERM');
  expect(group.members?.has(2_000_002)).toBe(false);
  expect(group.members?.has(2_000_004)).toBe(true);
});
it('refuses a reused leaderless group and never launders unknown members into evidence', () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const group: FixtureProcessGroup = {
    pid: 2_000_001,
    started: 'original',
    members: new Map([[2_000_002, 'old-member']]),
  };
  expect(() =>
    signalFixtureGroup(group, 'SIGKILL', snapshot(member(2_000_009, group.pid)))
  ).toThrow('continuity');
  expect(() =>
    signalFixtureGroup(
      group,
      'SIGKILL',
      snapshot(member(2_000_002, group.pid, 'old-member'))
    )
  ).toThrow('continuity');
  expect(kill).not.toHaveBeenCalled();
  expect(group.continuity).toBe('lost');
});
it('keeps a zombie identity as a witness while live original members remain', () => {
  const group: FixtureProcessGroup = {
    pid: 2_000_001,
    started: 'original',
    members: new Map([[2_000_002, 'original-member']]),
  };
  expect(
    fixtureGroupIsLive(
      group,
      snapshot(
        member(2_000_002, group.pid, 'original-member', 'Z'),
        member(2_000_003, group.pid)
      )
    )
  ).toBe(true);
});
it('retires lost continuity only after fresh absence or proven original-leader replacement', () => {
  const group: FixtureProcessGroup = {
    pid: 2_000_001,
    started: 'original',
    continuity: 'lost',
    members: new Map(),
  };
  expect(fixtureGroupIsLive(group, snapshot())).toBe(false);
  expect(
    fixtureGroupIsLive(
      group,
      snapshot(member(group.pid, group.pid, 'replacement'))
    )
  ).toBe(false);
});
it('retains same-identity group contradictions and initially missing authority', () => {
  const group: FixtureProcessGroup = { pid: 2_000_001, started: 'original' };
  expect(() =>
    fixtureGroupIsLive(
      group,
      snapshot(member(group.pid, 8, 'original'), member(2_000_002, group.pid))
    )
  ).toThrow('leader');
  expect(() =>
    fixtureGroupIsLive(
      { pid: group.pid },
      snapshot(member(group.pid, group.pid))
    )
  ).toThrow('unknown');
});
it.each([
  'broken',
  '1 1 1 S start\n1 1 1 S duplicate',
  '9007199254740992 1 1 S invalid',
  '2 1 2 S valid',
])('rejects partial or malformed global process authority: %s', (text) => {
  expect(() => parseFixtureProcessSnapshot(text, 1)).toThrow();
});
