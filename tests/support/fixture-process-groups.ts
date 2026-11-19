import { spawnSync } from 'node:child_process';

type ProcessRow = {
  pid: number;
  parent: number;
  group: number;
  state: string;
  started: string;
};

export type FixtureProcessGroup = {
  pid: number;
  started?: string;
};

export function inspectFixtureProcesses(): Map<number, ProcessRow> {
  const result = spawnSync(
    '/bin/ps',
    ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='],
    { encoding: 'utf8', timeout: 500, env: { LC_ALL: 'C' } }
  );
  if (result.error || result.status !== 0 || result.stderr.trim()) {
    throw new Error(
      `Cannot inspect fixture processes: ${result.error?.message ?? result.stderr}; exit ${result.status}`
    );
  }
  const rows = new Map<number, ProcessRow>();
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match)
      throw new Error(`Invalid fixture process inspection row: ${line}`);
    const row = {
      pid: Number(match[1]),
      parent: Number(match[2]),
      group: Number(match[3]),
      state: match[4]!,
      started: match[5]!,
    };
    rows.set(row.pid, row);
  }
  if (!rows.has(process.pid))
    throw new Error('Fixture process inspection omitted the test runner');
  return rows;
}

export function fixtureGroupIsLive(
  group: FixtureProcessGroup,
  rows: ReturnType<typeof inspectFixtureProcesses>
) {
  const leader = rows.get(group.pid);
  if (leader && leader.group !== group.pid && !leader.state.startsWith('Z')) {
    throw new Error(
      `Fixture process ${group.pid} is no longer its process-group leader`
    );
  }
  if (leader && group.started && leader.started !== group.started) {
    throw new Error(
      `Fixture process group ${group.pid} changed identity; refusing to signal it`
    );
  }
  if (leader && !group.started) group.started = leader.started;
  return [...rows.values()].some(
    (row) => row.group === group.pid && !row.state.startsWith('Z')
  );
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
      return { pid, started: leader.started };
    visited.add(row.pid);
    row = rows.get(row.parent);
  }
  throw new Error(
    `Fixture group ${pid} is not descended from an active fixture command`
  );
}
