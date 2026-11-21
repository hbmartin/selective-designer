import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { makeTestDatabaseUrl } from '@tests/server/test-database-url';
import {
  inspectFixtureProcesses,
  signalFixtureGroup,
  signalFixtureProcess,
  validateDetachedFixtureGroup,
} from '@tests/support/fixture-process-groups';

async function canListen(port: number) {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) =>
      server.once('error', reject).listen(port, '127.0.0.1', resolve)
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return true;
  } catch {
    return false;
  }
}
async function launch(mode = 'ready') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'e2e-owner-'));
  await writeFile(path.join(root, 'index.html'), '<h1>Owned server</h1>');
  const databaseUrl = makeTestDatabaseUrl({
    host: '127.0.0.1',
    port: 54329,
    databaseName: 'postgres',
  });
  const child = spawn(
    process.execPath,
    [
      path.resolve('run-jiti.js'),
      path.resolve('tests/support/e2e-webserver.fixture.ts'),
      root,
      mode,
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        E2E_DATABASE_URL: databaseUrl,
        NODE_ENV: 'test',
        TEST_E2E_SETUP_FAILURE: String(mode.startsWith('failure-')),
      },
    }
  );
  let output = '';
  child.stdout!.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    output += String(chunk);
  });
  const messages: string[] = [];
  child.on('message', (message: { type: string }) =>
    messages.push(message.type)
  );
  const exited = once(child, 'exit');
  await expect
    .poll(() => inspectFixtureProcesses().get(child.pid!)?.group, {
      timeout: 5000,
    })
    .toBe(child.pid);
  const rows = inspectFixtureProcesses();
  const identity = rows.get(child.pid!)!;
  const group = validateDetachedFixtureGroup(
    child.pid!,
    new Set([process.pid]),
    rows
  );
  return {
    child,
    messages,
    exited,
    databaseUrl,
    identity,
    output: () => output,
    async waitForExit() {
      await expect
        .poll(() => child.exitCode !== null || child.signalCode !== null, {
          timeout: 12_000,
        })
        .toBe(true);
      return exited;
    },
    async dispose() {
      signalFixtureGroup(group, 'SIGKILL');
      await exited;
      await rm(root, { recursive: true, force: true });
    },
  };
}
it.each(['SIGINT', 'SIGTERM'] as const)(
  'stops both listeners when only the ready launcher receives %s and allows immediate restart',
  async (signal) => {
    for (let run = 0; run < 2; run++) {
      const fixture = await launch();
      try {
        await expect
          .poll(() => fixture.messages, { timeout: 20_000 })
          .toContain('ready');
        expect(await canListen(54329)).toBe(false);
        expect(await canListen(3000)).toBe(false);
        signalFixtureProcess(fixture.identity, signal);
        await fixture.waitForExit();
        expect(await canListen(54329)).toBe(true);
        expect(await canListen(3000)).toBe(true);
      } finally {
        await fixture.dispose();
      }
    }
  },
  60_000
);
it.each(['SIGINT', 'SIGTERM'] as const)(
  'cancels setup without reopening listeners on %s',
  async (signal) => {
    const fixture = await launch('waiting');
    try {
      await expect
        .poll(fixture.output, { timeout: 20_000 })
        .toContain('Fixture setup waiting');
      signalFixtureProcess(fixture.identity, signal);
      await fixture.waitForExit();
      expect(await canListen(54329)).toBe(true);
      expect(await canListen(3000)).toBe(true);
      expect(fixture.messages).not.toContain('ready');
    } finally {
      await fixture.dispose();
    }
  },
  30_000
);
it.each([0, 1, 2, 3, 4])(
  'closes the database and skips subsequent stages after setup failure %s',
  async (stage) => {
    const fixture = await launch(`failure-${stage}`);
    try {
      const [status] = await fixture.waitForExit();
      expect(status).not.toBe(0);
      expect(fixture.output()).toContain('E2E setup failed');
      expect(
        fixture.output().match(/Fixture setup completed/g) ?? []
      ).toHaveLength(stage);
      expect(await canListen(54329)).toBe(true);
      expect(fixture.messages).not.toContain('ready');
    } finally {
      await fixture.dispose();
    }
  },
  30_000
);
it('preserves database contents through a Vite restart, then closes both servers', async () => {
  const fixture = await launch();
  const client = new Client({ connectionString: fixture.databaseUrl });
  try {
    await expect
      .poll(() => fixture.messages, { timeout: 20_000 })
      .toContain('ready');
    await client.connect();
    await client.query(
      'create table restart_evidence (value int); insert into restart_evidence values (42)'
    );
    fixture.child.send('restart');
    await expect
      .poll(() => fixture.messages, { timeout: 20_000 })
      .toContain('restarted');
    expect(
      (await client.query('select value from restart_evidence')).rows
    ).toEqual([{ value: 42 }]);
    await client.end();
    signalFixtureProcess(fixture.identity, 'SIGTERM');
    await fixture.waitForExit();
    expect(await canListen(54329)).toBe(true);
    expect(await canListen(3000)).toBe(true);
  } finally {
    await client.end();
    await fixture.dispose();
  }
}, 45_000);

it.each([54329, 3000])(
  'fails on an occupied port %s without replacing its owner',
  async (port) => {
    const occupied = net.createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(port, '127.0.0.1', resolve)
    );
    const fixture = await launch();
    try {
      const [status] = await fixture.waitForExit();
      expect(status).not.toBe(0);
      expect(await canListen(port)).toBe(false);
      expect(await canListen(port === 3000 ? 54329 : 3000)).toBe(true);
    } finally {
      await fixture.dispose();
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
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
      await expect
        .poll(fixture.output, { timeout: 20_000 })
        .toContain(`Fixture Vite ${mode}`);
      signalFixtureProcess(fixture.identity, signal);
      await expect.poll(fixture.output).toContain('Fixture signal received');
      fixture.child.send('release', () => {});
      await fixture.waitForExit();
      expect(await canListen(54329)).toBe(true);
      expect(await canListen(3000)).toBe(true);
      expect(fixture.messages).not.toContain('ready');
    } finally {
      await fixture.dispose();
    }
  },
  30_000
);
