import {
  inspectFixtureProcesses,
  type ProcessRow,
} from './fixture-process-snapshot.mjs';
export { inspectFixtureProcesses } from './fixture-process-snapshot.mjs';

export type FixtureProcessGroup = {
  pid: number;
  started?: string;
  members?: Map<number, string>;
  continuity?: 'authenticated' | 'lost';
};

export function seedFixtureProcessGroup(
  row: ProcessRow,
  rows: ReadonlyMap<number, ProcessRow>
): FixtureProcessGroup {
  return {
    pid: row.group,
    started: row.started,
    continuity: 'authenticated',
    members: new Map(
      [...rows.values()]
        .filter((member) => member.group === row.group)
        .map((member) => [member.pid, member.started])
    ),
  };
}

export function fixtureGroupIsLive(
  group: FixtureProcessGroup,
  rows: ReturnType<typeof inspectFixtureProcesses>
) {
  const leader = rows.get(group.pid);
  const members = [...rows.values()].filter((row) => row.group === group.pid);
  if (!members.some((row) => !row.state.startsWith('Z'))) return false;
  if (leader && group.started && leader.started !== group.started) return false;
  const uncertain = (message: string): never => {
    group.continuity = 'lost';
    group.members = new Map();
    throw new Error(message);
  };
  if (leader && leader.group !== group.pid)
    return uncertain(
      `Fixture process ${group.pid} is no longer its process-group leader`
    );
  if (!group.started)
    return uncertain(
      `Original fixture group identity is unknown: ${group.pid}`
    );
  if (group.continuity === 'lost')
    return uncertain(`Fixture group continuity is lost: ${group.pid}`);
  const witnesses = group.members ?? new Map([[group.pid, group.started]]);
  if (!members.some((row) => witnesses.get(row.pid) === row.started))
    return uncertain(`Fixture group continuity is lost: ${group.pid}`);
  group.members = new Map(members.map((row) => [row.pid, row.started]));
  group.continuity = 'authenticated';
  return true;
}

export function signalFixtureGroup(
  group: FixtureProcessGroup,
  signal: NodeJS.Signals,
  rows = inspectFixtureProcesses()
) {
  if (!fixtureGroupIsLive(group, rows)) return;
  try {
    process.kill(-group.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export function validateDetachedFixtureGroup(
  pid: number,
  roots: ReadonlySet<number>,
  rows = inspectFixtureProcesses()
): FixtureProcessGroup {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error(
      'Fixture group PID must be a safe integer greater than one'
    );
  const leader = rows.get(pid);
  if (!leader || leader.state.startsWith('Z') || leader.group !== pid) {
    throw new Error(
      `Fixture group ${pid} must have a live process-group leader`
    );
  }
  const ancestors = new Set<number>();
  let runner = rows.get(process.pid);
  while (runner && !ancestors.has(runner.pid)) {
    ancestors.add(runner.pid);
    if (runner.group === pid)
      throw new Error(
        `Cannot register the runner or an ancestor group: ${pid}`
      );
    runner = rows.get(runner.parent);
  }
  const visited = new Set<number>();
  let row = rows.get(leader.parent);
  while (row && !visited.has(row.pid)) {
    if (roots.has(row.pid) && !row.state.startsWith('Z'))
      return seedFixtureProcessGroup(leader, rows);
    visited.add(row.pid);
    row = rows.get(row.parent);
  }
  throw new Error(
    `Fixture group ${pid} is not descended from an active fixture command`
  );
}
