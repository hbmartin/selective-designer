import type { ProcessRow } from './fixture-process-snapshot.mjs';
export const FIXTURE_PROTOCOL_VERSION: 1;
export type SerializedFixtureError = {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  errno?: string | number;
  syscall?: string;
  path?: string;
  spawnargs?: string[];
};
type Envelope = { version: 1; nonce: string };
export type SupervisorMessage = Envelope &
  (
    | { type: 'owned' | 'workload'; identity: ProcessRow }
    | { type: 'retired' }
    | {
        type: 'target-exit';
        status: number | null;
        signal: NodeJS.Signals | null;
      }
    | { type: 'spawn-failed'; error: SerializedFixtureError }
    | { type: 'protocol-failed'; error: SerializedFixtureError }
    | {
        type: 'inspection-failed';
        stage: 'self' | 'workload';
        error: SerializedFixtureError;
      }
  );
export type SupervisorControl = Envelope &
  (
    | { type: 'retire' }
    | {
        type: 'start';
        command: string;
        args: string[];
        cwd: string;
        env: Record<string, string>;
      }
  );
export function serializeFixtureError(value: unknown): SerializedFixtureError;
export function restoreFixtureError(value: SerializedFixtureError): Error;
export function readSupervisorMessage(
  value: unknown,
  nonce: string
): SupervisorMessage | undefined;
export function readSupervisorControl(
  value: unknown,
  nonce: string
): SupervisorControl | undefined;
