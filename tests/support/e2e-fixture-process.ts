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
  databaseUrl?: string;
  httpPort?: number;
  pid?: number;
  exitCode?: string | number;
};
type Exit = {
  status: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
};

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
  const transportErrors: Error[] = [];
  const messages: E2EFixtureMessage[] = [];
  let output = '';

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
    try {
      if (group) {
        const rows = inspectFixtureProcesses(
          Math.max(1, Math.ceil(deadline - performance.now()))
        );
        signalFixtureGroup(group, 'SIGKILL', rows);
      } else if (
        child &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        // This retained direct-child handle does not authorize a group signal.
        child.kill('SIGKILL');
      }
    } catch (error) {
      failures.push(error);
    }
    if (exited && closed) {
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
    failures.push(...transportErrors);
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
    launched.on('message', (message: E2EFixtureMessage) =>
      messages.push(message)
    );
    exited = new Promise((resolve) => {
      launched.on('error', (error) => {
        if (launched.pid === undefined) {
          spawnError = error;
          resolve({ status: null, signal: null, spawnError: error });
        } else transportErrors.push(error);
      });
      launched.once('exit', (status, signal) => resolve({ status, signal }));
    });
    closed = new Promise((resolve) => {
      launched.once('close', () => resolve());
    });
    const deadline = performance.now() + 5_000;
    let rows = inspectFixtureProcesses(
      Math.max(1, Math.ceil(deadline - performance.now()))
    );
    while (!launched.pid || rows.get(launched.pid)?.group !== launched.pid) {
      if (spawnError) throw spawnError;
      if (launched.exitCode !== null || launched.signalCode !== null)
        throw new Error('Fixture exited before process-group confirmation');
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new Error('Fixture process-group confirmation timed out');
      await delay(Math.min(20, remaining));
      rows = inspectFixtureProcesses(
        Math.max(1, Math.ceil(deadline - performance.now()))
      );
    }
    const identity = rows.get(launched.pid!)!;
    group = validateDetachedFixtureGroup(
      launched.pid!,
      new Set([process.pid]),
      rows
    );
    return {
      root,
      child: launched,
      messages,
      identity,
      group,
      output: () => output,
      async message(type: string) {
        const deadline = performance.now() + 20_000;
        while (!messages.some((message) => message.type === type)) {
          if (launched.exitCode !== null || launched.signalCode !== null)
            throw new Error(`Fixture exited before ${type}: ${output}`);
          const remaining = deadline - performance.now();
          if (remaining <= 0)
            throw new Error(`Fixture message timed out: ${type}`);
          await delay(Math.min(20, remaining));
        }
        return messages.find((message) => message.type === type)!;
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
      throw new AggregateError(
        [error, cleanupError],
        error instanceof Error ? error.message : String(error),
        { cause: error }
      );
    }
    throw error;
  }
}
