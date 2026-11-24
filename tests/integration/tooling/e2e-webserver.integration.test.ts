import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import net, { type AddressInfo } from 'node:net';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import {
  inspectFixtureProcesses,
  fixtureGroupIsLive,
  signalFixtureProcess,
  signalFixtureGroup,
} from '@tests/support/fixture-process-groups';

import {
  launchE2EFixture as launch,
  type E2EFixturePorts as Ports,
} from '@tests/support/e2e-fixture-process';

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
async function expectListenersClosed(
  fixture: Awaited<ReturnType<typeof launch>>
) {
  for (const message of fixture.messages) {
    const port = message.databaseUrl
      ? Number(new URL(message.databaseUrl).port)
      : message.httpPort;
    if (port) expect(await canListen(port)).toBe(true);
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
        await expectListenersClosed(fixture);
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
    fixture.child.send('ping');
    await fixture.message('pong');
    expect(fixture.child.exitCode).toBeNull();
    expect(fixture.child.signalCode).toBeNull();
    await expectListenersClosed(fixture);
  } finally {
    await fixture.dispose();
  }
}, 30_000);

it.each(['programmatic-failure', 'programmatic-hang'])(
  'remains responsive with unchanged status after %s',
  async (mode) => {
    const fixture = await launch(mode);
    try {
      await fixture.ready();
      fixture.child.send('close');
      const failure = await fixture.message('close-failed');
      expect(failure.exitCode).toBe(7);
      fixture.child.send('ping-after-failure');
      expect((await fixture.message('pong-after-failure')).exitCode).toBe(7);
      fixture.child.send('release');
      await expect
        .poll(async () => {
          const database = fixture.messages.find(
            (message) => message.type === 'database-ready'
          )!;
          return canListen(Number(new URL(database.databaseUrl!).port));
        })
        .toBe(true);
      fixture.child.send('ping-after-release');
      expect((await fixture.message('pong-after-release')).exitCode).toBe(7);
      expect(fixture.child.exitCode).toBeNull();
    } finally {
      fixture.child.send('release', () => {});
      await fixture.dispose();
    }
  },
  30_000
);

it('bounds inherited-pipe draining and recovers through a previously verified descendant', async () => {
  const fixture = await launch();
  try {
    await fixture.ready();
    fixture.child.send('start-pipe-holder');
    const holder = await fixture.message('pipe-holder');
    await expect
      .poll(() => inspectFixtureProcesses().get(holder.pid!)?.group)
      .toBe(fixture.identity.group);
    const rows = inspectFixtureProcesses();
    expect(fixtureGroupIsLive(fixture.group, rows)).toBe(true);
    expect(fixture.group.members?.get(holder.pid!)).toBe(
      rows.get(holder.pid!)!.started
    );
    fixture.child.send('exit-parent');
    await expect(fixture.waitForExit()).rejects.toThrow(
      'output drain remains unconfirmed'
    );
    expect(fixture.child.exitCode).toBe(0);
    await fixture.dispose();
    await expectListenersClosed(fixture);
  } finally {
    await fixture.dispose();
  }
}, 30_000);

it('exits on CLI startup failure despite a lingering plugin handle', async () => {
  const fixture = await launch('startup-lingering');
  try {
    expect(await fixture.waitForExit()).toEqual([1, null]);
    expect(fixture.output()).toContain(
      'E2E startup failed: Fixture primary startup failure'
    );
    await expectListenersClosed(fixture);
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
      await expectListenersClosed(fixture);
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
      await expectListenersClosed(fixture);
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
    await fixture.message('restarted', { failureTypes: ['restart-failed'] });
    expect(
      (await client.query('select value from restart_evidence')).rows
    ).toEqual([{ value: 42 }]);
    await client.end();
    client = undefined;
    signalFixtureProcess(fixture.identity, 'SIGTERM');
    expect(await fixture.waitForExit()).toEqual([0, null]);
    await expectListenersClosed(fixture);
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
      await expectListenersClosed(fixture);
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
      await expectListenersClosed(fixture);
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
      await expectListenersClosed(fixture);
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
      'E2E startup failed: Fixture primary startup failure'
    );
    await expectListenersClosed(fixture);
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
      await expectListenersClosed(fixture);
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
      await expectListenersClosed(fixture);
    } finally {
      await fixture.dispose();
    }
  },
  30_000
);

it.each(
  (['SIGINT', 'SIGTERM'] as const).flatMap((signal) =>
    ['creation', 'listening'].flatMap((stage) =>
      ['signal-first', 'failure-first'].map((order) => ({
        signal,
        stage,
        order,
      }))
    )
  )
)(
  'retains genuine $stage failure with $order $signal',
  async ({ signal, stage, order }) => {
    const fixture = await launch(`race-${stage}`);
    try {
      await fixture.message('failure-gate');
      if (order === 'signal-first') {
        signalFixtureProcess(fixture.identity, signal);
        await expect.poll(fixture.output).toContain('Fixture signal received');
      }
      fixture.child.send('release');
      await fixture.message('cleanup-gate');
      if (order === 'failure-first')
        signalFixtureProcess(fixture.identity, signal);
      fixture.child.send('finish-cleanup');
      expect(await fixture.waitForExit()).toEqual([1, null]);
      expect(fixture.output()).toContain(
        `E2E startup failed: Fixture genuine ${stage} failure`
      );
      await expectListenersClosed(fixture);
    } finally {
      fixture.child.send('release', () => {});
      fixture.child.send('finish-cleanup', () => {});
      await fixture.dispose();
    }
  },
  30_000
);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'reports a setup nonzero exit despite cancellation by %s',
  async (signal) => {
    const fixture = await launch('setup-nonzero-on-stop');
    try {
      await expect
        .poll(fixture.output, { timeout: 20_000 })
        .toContain('Fixture setup exits nonzero on stop');
      signalFixtureProcess(fixture.identity, signal);
      expect(await fixture.waitForExit()).toEqual([1, null]);
      expect(fixture.output()).toContain(
        'e2e-webserver-nonzero.fixture.ts (2)'
      );
      await expectListenersClosed(fixture);
    } finally {
      await fixture.dispose();
    }
  },
  30_000
);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'cancels setup successfully after verified process-group %s',
  async (signal) => {
    const fixture = await launch('waiting');
    try {
      await expect
        .poll(fixture.output, { timeout: 20_000 })
        .toContain('Fixture setup waiting');
      signalFixtureGroup(fixture.group, signal, inspectFixtureProcesses());
      expect(await fixture.waitForExit()).toEqual([0, null]);
      expect(fixture.output()).not.toContain('E2E startup failed');
      await expectListenersClosed(fixture);
    } finally {
      await fixture.dispose();
    }
  },
  30_000
);
it('joins repeated Ctrl-C while final output is held without an extra SIGINT listener', async () => {
  const fixture = await launch('final-flush');
  try {
    await fixture.ready();
    signalFixtureProcess(fixture.identity, 'SIGINT');
    await fixture.message('flush-held');
    signalFixtureProcess(fixture.identity, 'SIGINT');
    fixture.child.send('ping-during-flush');
    await fixture.message('pong-during-flush');
    expect(fixture.child.exitCode).toBeNull();
    expect(fixture.child.signalCode).toBeNull();
    fixture.child.send('release-flush');
    expect(await fixture.waitForExit()).toEqual([0, null]);
    await expectListenersClosed(fixture);
  } finally {
    await fixture.dispose();
  }
}, 30_000);
it.each(['restart-fail', 'restart-recover'])(
  'preserves the active server and database through %s and closes all instances',
  async (mode) => {
    const fixture = await launch(mode);
    let client: Client | undefined;
    try {
      const ready = await fixture.ready();
      client = new Client({ connectionString: ready.databaseUrl });
      await client.connect();
      await client.query(
        'create table partial_restart(value integer); insert into partial_restart values(42)'
      );
      const rounds = mode === 'restart-recover' ? 3 : 1;
      for (let round = 0; round < rounds; round++) {
        const afterIndex = fixture.messages.length;
        fixture.child.send('restart');
        await fixture.message('restarted', {
          failureTypes: ['restart-failed'],
          afterIndex,
        });
        expect(
          (await client.query('select value from partial_restart')).rows
        ).toEqual([{ value: 42 }]);
        expect((await fetch(`http://127.0.0.1:${ready.http}/`)).status).toBe(
          200
        );
      }
      expect(fixture.output()).toContain('server restart failed');
      await client.end();
      client = undefined;
      fixture.child.send('close');
      expect(await fixture.message('closed')).toMatchObject({
        watchersClosed: true,
        instances: rounds + 1,
      });
      fixture.child.send('ping-after-close');
      await fixture.message('pong-after-close');
      await expectListenersClosed(fixture);
      const replacement = await launch('ready', {
        database: ready.database,
        http: ready.http,
      });
      try {
        expect(await replacement.ready()).toMatchObject({
          database: ready.database,
          http: ready.http,
        });
      } finally {
        await replacement.dispose();
      }
    } finally {
      await client?.end();
      await fixture.dispose();
    }
  },
  60_000
);
it('warns before forcing exit at the terminal deadline when final flushing stalls', async () => {
  const fixture = await launch('final-flush-stalled');
  try {
    await fixture.ready();
    signalFixtureProcess(fixture.identity, 'SIGINT');
    await fixture.message('flush-held');
    signalFixtureProcess(fixture.identity, 'SIGINT');
    expect(await fixture.waitForExit()).toEqual([1, null]);
    expect(fixture.output()).toContain(
      'shutdown remains pending after nine seconds'
    );
    await expectListenersClosed(fixture);
  } finally {
    await fixture.dispose();
  }
}, 30_000);

it('registers ownership before a config-file application plugin fails', async () => {
  const fixture = await launch('config-plugin-failure');
  try {
    expect(await fixture.waitForExit()).toEqual([1, null]);
    expect(await fixture.message('early-watcher-closed')).toEqual({
      type: 'early-watcher-closed',
    });
    expect(fixture.output()).toContain('Fixture early config plugin failure');
    await expectListenersClosed(fixture);
  } finally {
    await fixture.dispose();
  }
}, 30_000);
it('retires failed restart watchers before an env change and keeps one live instance', async () => {
  const fixture = await launch('restart-fail');
  let client: Client | undefined;
  async function observation() {
    const count = fixture.messages.filter(
      (message) => message.type === 'instances'
    ).length;
    fixture.child.send('inspect-instances');
    await expect
      .poll(
        () =>
          fixture.messages.filter((message) => message.type === 'instances')
            .length
      )
      .toBe(count + 1);
    return fixture.messages
      .filter((message) => message.type === 'instances')
      .at(-1)!;
  }
  try {
    const ready = await fixture.ready();
    client = new Client({ connectionString: ready.databaseUrl });
    await client.connect();
    await client.query(
      'create table env_restart(value integer); insert into env_restart values(42)'
    );
    await observation();
    fixture.child.send('restart');
    await fixture.message('restarted', { failureTypes: ['restart-failed'] });
    expect(await observation()).toMatchObject({
      instances: 2,
      watchersOpen: 1,
      instancesClosed: 1,
    });
    fixture.child.send('abandoned-env-change');
    await fixture.message('abandoned-change-delivered', {
      failureTypes: ['abandoned-change-failed'],
    });
    expect(await observation()).toMatchObject({
      instances: 2,
      watchersOpen: 1,
    });
    // A real env-file change must restart only the working instance. Its abandoned
    // predecessor has already completed watcher closure before restart resolved.
    await writeFile(
      path.join(fixture.root, '.env'),
      'FIXTURE_ENV_REVISION=2\n'
    );
    await expect
      .poll(async () => (await observation()).instances, { timeout: 20_000 })
      .toBeGreaterThan(2);
    // Filesystem backends may deliver both add and change for one write. Each
    // legitimate restart still leaves one live watcher and retires its predecessor.
    await expect
      .poll(async () => {
        const state = await observation();
        return {
          watchersOpen: state.watchersOpen,
          retired: state.instancesClosed === state.instances! - 1,
        };
      })
      .toEqual({ watchersOpen: 1, retired: true });
    expect((await client.query('select value from env_restart')).rows).toEqual([
      { value: 42 },
    ]);
    await expect
      .poll(
        async () => (await fetch(`http://127.0.0.1:${ready.http}/`)).status,
        { timeout: 10_000 }
      )
      .toBe(200);
    await client.end();
    client = undefined;
    fixture.child.send('close');
    await fixture.message('closed');
    expect(fixture.output()).not.toContain('E2E startup cancelled');
    await expectListenersClosed(fixture);
  } finally {
    await client?.end();
    await fixture.dispose();
  }
}, 60_000);
it.each(['SIGINT', 'SIGTERM'] as const)(
  'keeps startup-timeout cleanup responsive until PID-only %s joins and cleanup finishes',
  async (signal) => {
    const fixture = await launch('programmatic-startup-timeout');
    try {
      expect(await fixture.message('startup-failed')).toMatchObject({
        exitCode: 7,
      });
      signalFixtureProcess(fixture.identity, signal);
      fixture.child.send('ping-after-startup-timeout');
      await fixture.message('pong-after-startup-timeout');
      expect(fixture.child.exitCode).toBeNull();
      fixture.child.send('release');
      expect(await fixture.waitForExit()).toEqual([1, null]);
      expect(
        fixture
          .output()
          .match(
            /E2E cleanup failed: E2E resource cleanup exceeded ten seconds/g
          )
      ).toHaveLength(1);
      await expectListenersClosed(fixture);
    } finally {
      await fixture.dispose();
    }
  },
  40_000
);

it('observes a real disconnected response channel without crashing the launcher', async () => {
  const fixture = await launch();
  try {
    await fixture.ready();
    fixture.child.send('disconnect-action');
    await fixture.waitForOutput('E2E fixture response transport diagnostic:');
    expect(fixture.output()).toContain('ERR_IPC_CHANNEL_CLOSED');
    expect(fixture.output()).not.toContain("Unhandled 'error' event");
    signalFixtureProcess(fixture.identity, 'SIGTERM');
    expect(await fixture.waitForExit()).toEqual([0, null]);
    await expectListenersClosed(fixture);
  } finally {
    await fixture.dispose();
  }
}, 30_000);
