export type ProcessRow = {
  pid: number;
  parent: number;
  group: number;
  state: string;
  started: string;
};
export function inspectFixtureProcesses(
  timeoutMs?: number
): Map<number, ProcessRow>;
export function parseFixtureProcessSnapshot(
  text: string,
  observerPid: number
): Map<number, ProcessRow>;
