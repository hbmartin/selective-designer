import { spawnSync } from 'node:child_process';

/** One complete snapshot, or an error. Never return partial authority. */
export function inspectFixtureProcesses(timeoutMs = 500) {
  const result = spawnSync(
    '/bin/ps',
    ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='],
    {
      encoding: 'utf8',
      timeout: Math.max(1, Math.min(500, timeoutMs)),
      env: { LC_ALL: 'C' },
    }
  );
  if (result.error || result.status !== 0 || result.stderr.trim()) {
    throw new Error(
      `Cannot inspect fixture processes: ${result.error?.message ?? result.stderr}; exit ${result.status}`
    );
  }
  return parseFixtureProcessSnapshot(result.stdout, process.pid);
}

export function parseFixtureProcessSnapshot(text, observerPid) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match)
      throw new Error(`Invalid fixture process inspection row: ${line}`);
    const row = {
      pid: Number(match[1]),
      parent: Number(match[2]),
      group: Number(match[3]),
      state: match[4],
      started: match[5],
    };
    if (
      ![row.pid, row.parent, row.group].every(
        (value) => Number.isSafeInteger(value) && value >= 0
      ) ||
      row.pid === 0 ||
      rows.has(row.pid)
    ) {
      throw new Error(`Invalid fixture process identity: ${line}`);
    }
    rows.set(row.pid, row);
  }
  if (!rows.has(observerPid))
    throw new Error('Fixture process inspection omitted the observer');
  return rows;
}
