import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import {
  inspectFixtureProcesses,
  signalFixtureGroup,
  signalFixtureProcess,
  validateDetachedFixtureGroup,
} from '@tests/support/fixture-process-groups';

type Ports = { database?: number; http?: number };
type Message = { type: string; databaseUrl?: string; httpPort?: number };

async function listen(server: net.Server, port = 0) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}
async function closeListener(server: net.Server) {
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
}
async function canListen(port: number) {
  const server = net.createServer();
  try {
    await listen(server, port);
    return true;
  } catch {
    return false;
  } finally {
    await closeListener(server);
  }
}
async function launch(mode = 'ready', requestedPorts: Ports = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-owner-'));
  let group: ReturnType<typeof validateDetachedFixtureGroup> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<[number | null, NodeJS.Signals | null]> | undefined;
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
    let output = '';
    launched.stdout!.on('data', (chunk) => {
      output += String(chunk);
    });
    launched.stderr!.on('data', (chunk) => {
      output += String(chunk);
    });
    const messages: Message[] = [];
    launched.on('message', (message: Message) => messages.push(message));
    closed = new Promise((resolve, reject) => {
      launched.once('error', reject);
      launched.once('close', (status, signal) => resolve([status, signal]));
    });
    void closed.catch(() => undefined);
    await expect
      .poll(() => inspectFixtureProcesses().get(launched.pid!)?.group, {
        timeout: 5000,
      })
      .toBe(launched.pid);
    const rows = inspectFixtureProcesses();
    const identity = rows.get(launched.pid!)!;
    group = validateDetachedFixtureGroup(
      launched.pid!,
      new Set([process.pid]),
      rows
    );
    const ownedGroup = group;
    const completion = closed;
    return {
      child: launched,
      messages,
      identity,
      output: () => output,
      async message(type: string) {
        await expect
          .poll(() => messages.some((message) => message.type === type), {
            timeout: 20_000,
          })
          .toBe(true);
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
      async expectListenersClosed() {
        for (const message of messages) {
          const port = message.databaseUrl
            ? Number(new URL(message.databaseUrl).port)
            : message.httpPort;
          if (port) expect(await canListen(port)).toBe(true);
        }
      },
      async waitForExit() {
        await expect
          .poll(
            () => launched.exitCode !== null || launched.signalCode !== null,
            {
              timeout: 12_000,
            }
          )
          .toBe(true);
        return completion;
      },
      async dispose() {
        signalFixtureGroup(ownedGroup, 'SIGKILL');
        await completion;
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (group) signalFixtureGroup(group, 'SIGKILL');
    if (closed) await closed.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

it.each(['SIGINT', 'SIGTERM'] as const)(
  'exits with a lingering plugin after PID-only %s and immediately reuses its ports',
  async (signal) => {
    let ports: Ports = {};
    for (let run = 0; run < 2; run++) {
      const fixture = await launch('lingering', ports);
      try {
        const ready = await fixture.ready();
        if (run > 0) expect(ready).toMatchObject(ports);
        ports = { database: ready.database, http: ready.http };
        expect(await canListen(ready.database)).toBe(false);
        expect(await canListen(ready.http)).toBe(false);
        signalFixtureProcess(fixture.identity, signal);
        expect(await fixture.waitForExit()).toEqual([0, null]);
        expect(fixture.output()).toContain('Fixture final close');
        await fixture.expectListenersClosed();
      } finally {
        await fixture.dispose();
      }
    }
  },
  60_000
);

it('closes resources idempotently without exiting its caller', async () => {
  const fixture = await launch();
  try {
    await fixture.ready();
    fixture.child.send('close');
    await fixture.message('closed');
    expect(fixture.child.exitCode).toBeNull();
    expect(fixture.child.signalCode).toBeNull();
    await fixture.expectListenersClosed();
  } finally {
    await fixture.dispose();
  }
}, 30_000);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'cancels setup without reopening listeners on %s',
  async (signal) => {
    const fixture = await launch('waiting');
    try {
      await fixture.message('database-ready');
      await expect
        .poll(fixture.output, { timeout: 20_000 })
        .toContain('Fixture setup waiting');
      signalFixtureProcess(fixture.identity, signal);
      expect(await fixture.waitForExit()).toEqual([0, null]);
      await fixture.expectListenersClosed();
      expect(fixture.messages.map(({ type }) => type)).not.toContain('ready');
    } finally {
      await fixture.dispose();
    }
  },
  30_000
);

it.each([0, 1, 2, 3, 4])(
  'closes the database and skips later stages after setup failure %s',
  async (stage) => {
    const fixture = await launch(`failure-${stage}`);
    try {
      const [status] = await fixture.waitForExit();
      expect(status).not.toBe(0);
      expect(fixture.output()).toContain('E2E setup failed');
      expect(
        fixture.output().match(/Fixture setup completed/g) ?? []
      ).toHaveLength(stage);
      await fixture.expectListenersClosed();
      expect(fixture.messages.map(({ type }) => type)).not.toContain('ready');
    } finally {
      await fixture.dispose();
    }
  },
  30_000
);

it('preserves data through Vite restart, then releases both listeners', async () => {
  const fixture = await launch();
  let client: Client | undefined;
  try {
    const ready = await fixture.ready();
    client = new Client({ connectionString: ready.databaseUrl });
    await client.connect();
    await client.query(
      'create table restart_evidence (value int); insert into restart_evidence values (42)'
    );
    fixture.child.send('restart');
    await fixture.message('restarted');
    expect(
      (await client.query('select value from restart_evidence')).rows
    ).toEqual([{ value: 42 }]);
    await client.end();
    client = undefined;
    signalFixtureProcess(fixture.identity, 'SIGTERM');
    expect(await fixture.waitForExit()).toEqual([0, null]);
    await fixture.expectListenersClosed();
  } finally {
    await client?.end();
    await fixture.dispose();
  }
}, 45_000);

it.each(['database', 'http'] as const)(
  'preserves an occupied test-owned %s listener',
  async (listener) => {
    const marker = `owned-${listener}`;
    const sentinel = net.createServer((socket) => socket.end(marker));
    let fixture: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      const port = await listen(sentinel);
      fixture = await launch('ready', { [listener]: port });
      expect((await fixture.waitForExit())[0]).not.toBe(0);
      expect(await canListen(port)).toBe(false);
      const response = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        let data = '';
        socket.on('data', (chunk) => {
          data += String(chunk);
        });
        socket.once('error', reject);
        socket.once('end', () => resolve(data));
      });
      expect(response).toBe(marker);
      await fixture.expectListenersClosed();
    } finally {
      await fixture?.dispose();
      await closeListener(sentinel);
    }
  },
  30_000
);

it.each(
  (['SIGINT', 'SIGTERM'] as const).flatMap((signal) =>
    ['creating', 'listening'].map((mode) => ({ signal, mode }))
  )
)(
  'does not reopen listeners after $signal during Vite $mode',
  async ({ signal, mode }) => {
    const fixture = await launch(mode);
    try {
      await fixture.message('database-ready');
      await expect
        .poll(fixture.output, { timeout: 20_000 })
        .toContain(`Fixture Vite ${mode}`);
      signalFixtureProcess(fixture.identity, signal);
      await expect.poll(fixture.output).toContain('Fixture signal received');
      fixture.child.send('release', () => {});
      expect(await fixture.waitForExit()).toEqual([0, null]);
      await fixture.expectListenersClosed();
      expect(fixture.messages.map(({ type }) => type)).not.toContain('ready');
    } finally {
      await fixture.dispose();
    }
  },
  30_000
);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'reports final-close failure before exiting after %s',
  async (signal) => {
    const fixture = await launch('cleanup-failure');
    try {
      await fixture.ready();
      signalFixtureProcess(fixture.identity, signal);
      expect(await fixture.waitForExit()).toEqual([1, null]);
      expect(fixture.output()).toContain(
        'E2E cleanup failed: Fixture secondary cleanup failure'
      );
      await fixture.expectListenersClosed();
    } finally {
      await fixture.dispose();
    }
  },
  30_000
);

it('retains the startup failure when final cleanup also fails', async () => {
  const fixture = await launch('startup-cleanup-failure');
  try {
    expect(await fixture.waitForExit()).toEqual([1, null]);
    expect(fixture.output()).toContain(
      'E2E cleanup failed: Fixture secondary cleanup failure'
    );
    expect(fixture.output()).toContain(
      'Fixture startup failed: Fixture primary startup failure'
    );
    await fixture.expectListenersClosed();
  } finally {
    await fixture.dispose();
  }
}, 30_000);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'preserves a pre-existing nonzero exit status on %s',
  async (signal) => {
    const fixture = await launch('nonzero-status');
    try {
      await fixture.ready();
      signalFixtureProcess(fixture.identity, signal);
      expect(await fixture.waitForExit()).toEqual([7, null]);
      await fixture.expectListenersClosed();
    } finally {
      await fixture.dispose();
    }
  },
  30_000
);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'fails cancellation when final cleanup fails after %s',
  async (signal) => {
    const fixture = await launch('listening-cleanup-failure');
    try {
      await fixture.message('listening');
      signalFixtureProcess(fixture.identity, signal);
      await expect.poll(fixture.output).toContain('Fixture signal received');
      fixture.child.send('release', () => {});
      expect(await fixture.waitForExit()).toEqual([1, null]);
      expect(fixture.output()).toContain(
        'E2E cleanup failed: Fixture secondary cleanup failure'
      );
      await fixture.expectListenersClosed();
    } finally {
      await fixture.dispose();
    }
  },
  30_000
);
