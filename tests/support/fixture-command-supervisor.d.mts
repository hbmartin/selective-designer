import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { ProcessRow } from './fixture-process-snapshot.mjs';
export type SupervisorRuntime = {
  ipc: {
    pid: number;
    ppid: number;
    argv: string[];
    connected: boolean;
    on(event: string, callback: (...args: unknown[]) => void): unknown;
    send(message: unknown, callback: (error?: Error | null) => void): unknown;
    exit(status: number): unknown;
  };
  spawnTarget: (
    command: string,
    args: string[],
    options: SpawnOptions
  ) => ChildProcess;
  inspect: () => Map<number, ProcessRow>;
};
export function runFixtureCommandSupervisor(
  options?: Partial<SupervisorRuntime>
): void;
