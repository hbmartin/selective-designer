import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  inspectFixtureProcesses,
  signalFixtureGroup,
  validateDetachedFixtureGroup,
  type FixtureProcessGroup,
} from './fixture-process-groups';
import { beforeDeadline } from './promise-deadline';

export type E2EFixturePorts = { database?: number; http?: number };
export type E2EFixtureMessage = {
  type: string;
  error?: string;
  databaseUrl?: string;
  httpPort?: number;
  pid?: number;
  exitCode?: string | number;
  watchersClosed?: boolean;
  instances?: number;
  instancesClosed?: number;
  watchersOpen?: number;
  sigtermHandlers?: number;
};
type Exit = {
  status: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
};

export class E2EFixtureLaunchError extends AggregateError {
  constructor(
    original: unknown,
    cleanupError: unknown,
    readonly retryCleanup: () => Promise<void>
  ) {
    super(
      [original, cleanupError],
      original instanceof Error ? original.message : String(original),
      { cause: original }
    );
  }
}

export async function launchE2EFixture(
  mode = 'ready',
  requestedPorts: E2EFixturePorts = {}
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-owner-'));
  let group: FixtureProcessGroup | undefined;
  let child: ChildProcess | undefined;
  let exited: Promise<Exit> | undefined;
  let closed: Promise<void> | undefined;
  let spawnError: Error | undefined;
  let ipcDrained = false;
  let outputDrained = false;
  const transportErrors: Error[] = [];
  let reportedTransportErrors = 0;
  function reportTransportErrors() {
    for (const error of transportErrors.slice(reportedTransportErrors))
      console.warn('E2E fixture transport diagnostic:', error);
    reportedTransportErrors = transportErrors.length;
  }
  const messages: E2EFixtureMessage[] = [];
  let output = '';
  let retrying: Promise<void> | undefined;
  let cleaned = false;

  function retryCleanup() {
    if (cleaned) return Promise.resolve();
    retrying ??= dispose()
      .then(() => {
        cleaned = true;
      })
      .finally(() => {
        retrying = undefined;
      });
    return retrying;
  }

  function stopDirectChild() {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  }

  async function waitForExit(deadline = performance.now() + 12_000) {
    if (!exited || !closed) throw new Error('Fixture did not spawn');
    const outcome = await beforeDeadline(
      exited,
      deadline,
      `Fixture process exit remains unconfirmed; retained ${root}`
    );
    await beforeDeadline(
      closed,
      deadline,
      `Fixture output drain remains unconfirmed; retained ${root}`
    );
    if (outcome.spawnError) throw outcome.spawnError;
    return [outcome.status, outcome.signal] as const;
  }
  async function dispose() {
    const deadline = performance.now() + 3_000;
    const failures: unknown[] = [];
    // A failed group pass sends no signal: one group kill either runs or throws.
    let awaitExit = true;
    try {
      if (group) {
        const rows = inspectFixtureProcesses(
          Math.max(1, Math.ceil(deadline - performance.now()))
        );
        signalFixtureGroup(group, 'SIGKILL', rows);
      } else {
        // This retained direct-child handle does not authorize a group signal.
        stopDirectChild();
      }
    } catch (error) {
      failures.push(error);
      if (group) awaitExit = false;
      // Once authorized, the leader may be the only retained witness for
      // descendants created since launch. Preserve it for a fresh attempt.
    }
    if (awaitExit && exited && closed) {
      try {
        const outcome = await beforeDeadline(
          exited,
          deadline,
          'Fixture process exit remains unconfirmed'
        );
        await beforeDeadline(
          closed,
          deadline,
          'Fixture output drain remains unconfirmed'
        );
        if (outcome.spawnError && outcome.spawnError !== spawnError)
          failures.push(outcome.spawnError);
      } catch (error) {
        failures.push(error);
      }
    }
    reportTransportErrors();
    if (failures.length)
      throw new AggregateError(
        failures,
        `Fixture cleanup remains unresolved; retained ${root}`,
        { cause: failures[0] }
      );
    await rm(root, { recursive: true, force: true });
  }
  try {
    await writeFile(path.join(root, 'index.html'), '<h1>Owned server</h1>');
    child = spawn(
      process.execPath,
      [
        path.resolve('run-jiti.js'),
        path.resolve('tests/support/e2e-webserver.fixture.ts'),
        root,
        mode,
        JSON.stringify(requestedPorts),
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          E2E_DATABASE_URL: '',
          NODE_ENV: 'test',
          TEST_E2E_SETUP_FAILURE: String(mode.startsWith('failure-')),
        },
      }
    );
    const launched = child;
    launched.stdout!.on('data', (chunk) => {
      output += String(chunk);
    });
    launched.stderr!.on('data', (chunk) => {
      output += String(chunk);
    });
    let announce!: () => void;
    let rejectAnnouncement!: (error: Error) => void;
    const announced = new Promise<void>((resolve, reject) => {
      announce = resolve;
      rejectAnnouncement = reject;
    });
    launched.on('message', (message: E2EFixtureMessage) => {
      messages.push(message);
      if (message.type === 'authorization-ready') announce();
    });
    launched.once('disconnect', () => {
      ipcDrained = true;
      rejectAnnouncement(new Error('Fixture authorization IPC disconnected'));
    });
    exited = new Promise((resolve) => {
      launched.on('error', (error) => {
        if (launched.pid === undefined) {
          spawnError = error;
          rejectAnnouncement(error);
          resolve({ status: null, signal: null, spawnError: error });
        } else transportErrors.push(error);
      });
      launched.once('exit', (status, signal) => {
        rejectAnnouncement(
          new Error('Fixture exited before process-group confirmation')
        );
        resolve({ status, signal });
      });
    });
    closed = new Promise((resolve) => {
      launched.once('close', () => {
        outputDrained = true;
        resolve();
      });
    });
    const deadline = performance.now() + 5_000;
    await beforeDeadline(
      announced,
      deadline,
      () =>
        `Fixture bootstrap authorization readiness timed out; output=${output}`
    );
    let lastInspectionError: unknown;
    let rows: ReturnType<typeof inspectFixtureProcesses>;
    while (true) {
      if (spawnError) throw spawnError;
      if (launched.exitCode !== null || launched.signalCode !== null)
        throw new Error('Fixture exited before process-group confirmation');
      if (ipcDrained) throw new Error('Fixture authorization IPC disconnected');
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new Error('Fixture process-group confirmation timed out', {
          cause: lastInspectionError,
        });
      try {
        rows = inspectFixtureProcesses(Math.max(1, Math.ceil(remaining)));
        lastInspectionError = undefined;
        if (
          performance.now() < deadline &&
          launched.pid &&
          rows.get(launched.pid)?.group === launched.pid
        )
          break;
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        if (
          !cause ||
          typeof cause !== 'object' ||
          !('code' in cause) ||
          !['ETIMEDOUT', 'EINTR', 'EAGAIN', 'EBUSY'].includes(
            String(cause.code)
          )
        )
          throw error;
        lastInspectionError = error;
      }
      await delay(Math.max(0, Math.min(20, deadline - performance.now())));
    }
    const identity = rows.get(launched.pid!)!;
    group = validateDetachedFixtureGroup(
      launched.pid!,
      new Set([process.pid]),
      rows
    );
    if (performance.now() >= deadline)
      throw new Error('Fixture authorization delivery timed out');
    await beforeDeadline(
      new Promise<void>((resolve, reject) => {
        launched.send({ type: 'authorize' }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
      deadline,
      'Fixture authorization delivery timed out'
    );
    return {
      root,
      child: launched,
      messages,
      identity,
      group,
      output: () => output,
      async waitForOutput(checkpoint: string, timeoutMs = 10_000) {
        const deadline = performance.now() + timeoutMs;
        while (!output.includes(checkpoint)) {
          if (outputDrained || performance.now() >= deadline)
            throw new Error(
              `Fixture checkpoint missing: ${checkpoint}; exit=${launched.exitCode}, signal=${launched.signalCode}, disconnected=${ipcDrained}; output=${output}`
            );
          await delay(Math.min(20, Math.max(0, deadline - performance.now())));
        }
      },
      async message(
        type: string,
        options: { failureTypes?: readonly string[]; afterIndex?: number } = {}
      ) {
        const deadline = performance.now() + 20_000;
        while (true) {
          const outcome = messages
            .slice(options.afterIndex ?? 0)
            .find(
              (message) =>
                message.type === type ||
                options.failureTypes?.includes(message.type)
            );
          if (outcome) {
            if (outcome.type === type) return outcome;
            throw new Error(
              `Fixture action failed: ${outcome.type}: ${outcome.error ?? 'No error reported'}; output=${output}`
            );
          }
          if (ipcDrained)
            throw new Error(`Fixture IPC closed before ${type}: ${output}`);
          const remaining = deadline - performance.now();
          if (remaining <= 0)
            throw new Error(`Fixture message timed out: ${type}`);
          await delay(Math.min(20, remaining));
        }
      },
      async ready() {
        const ready = await this.message('ready');
        const database = await this.message('database-ready');
        return {
          databaseUrl: database.databaseUrl!,
          database: Number(new URL(database.databaseUrl!).port),
          http: ready.httpPort!,
        };
      },
      waitForExit,
      dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new E2EFixtureLaunchError(error, cleanupError, retryCleanup);
    }
    reportTransportErrors();
    throw error;
  }
}
