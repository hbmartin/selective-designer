import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import {
  inspectFixtureProcesses,
  signalFixtureProcess,
} from '@tests/support/fixture-process-groups';
import {
  createWorkflowFixture,
  disposeWorkflowFixtures,
  fixtureEnvironment,
  runFixtureCommand,
} from '@tests/support/workflow-fixtures';

const fixtures: ReturnType<typeof createWorkflowFixture>[] = [];
afterEach(() => disposeWorkflowFixtures(fixtures));

it.each(['SIGINT', 'SIGTERM'] as const)(
  'publishes real CLI evidence after verified PID-only %s',
  async (signal) => {
    const fixture = createWorkflowFixture();
    fixtures.push(fixture);
    const pidFile = path.join(fixture.support, 'runner.pid');
    const readyFile = path.join(fixture.support, 'step.ready');
    const callsFile = path.join(fixture.support, 'calls');
    const entry = path.join(fixture.support, 'runner.mjs');
    await writeFile(
      path.join(fixture.bin, 'pnpm'),
      `#!${process.execPath}\nconst fs=require('node:fs');\nfs.appendFileSync(${JSON.stringify(callsFile)},process.argv.slice(2).join(' ')+'\\n');\nfor(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>process.stdout.write('final step output\\n',()=>process.exit(0)));\nfs.writeFileSync(${JSON.stringify(readyFile)},'ready');\nsetInterval(()=>{},1000);\n`,
      { mode: 0o700 }
    );
    await writeFile(
      entry,
      `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));await import(${JSON.stringify(pathToFileURL(path.resolve('scripts/task-verify.mjs')).href)});`
    );
    const running = runFixtureCommand(process.execPath, [entry], fixture, {
      env: fixtureEnvironment(fixture),
      timeoutMs: 15000,
    });
    await expect
      .poll(
        async () =>
          access(readyFile).then(
            () => true,
            () => false
          ),
        { timeout: 8000 }
      )
      .toBe(true);
    const pid = Number(await readFile(pidFile, 'utf8'));
    const identity = inspectFixtureProcesses().get(pid);
    expect(identity).toBeDefined();
    signalFixtureProcess(identity!, signal);
    const result = await running;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(signal === 'SIGINT' ? 130 : 143);
    expect(result.stdout).toContain('final step output');
    expect(await readFile(callsFile, 'utf8')).toBe('format:changed\n');
    const reports = path.join(fixture.cwd, 'test-results', 'task-verification');
    const [report] = await readdir(reports);
    const summary = path.join(reports, report!, 'summary.md');
    expect(await readFile(summary, 'utf8')).toContain('Status: interrupted');
    expect(
      await readFile(path.join(reports, report!, 'format-changed.log'), 'utf8')
    ).toContain('final step output');
    expect(result.stdout).toContain(`Verification report: ${summary}`);
  },
  20000
);

const recoveryIO: {
  chmod: (target: string, mode: number) => Promise<void>;
  readFile: (target: string, encoding: 'utf8') => Promise<string>;
  readdir: (target: string) => Promise<string[]>;
  rm: (
    target: string,
    options: { recursive: boolean; force: boolean }
  ) => Promise<void>;
} = { chmod, readFile, readdir, rm };
async function withRecoveryCleanup(
  paths: { parent: string; manifest: string },
  observe: (state: { ordinary?: string; staging?: string }) => Promise<void>,
  io: typeof recoveryIO = recoveryIO
) {
  const state: { ordinary?: string; staging?: string } = {};
  const failures: unknown[] = [];
  try {
    await observe(state);
  } catch (error) {
    failures.push(error);
  }
  try {
    let candidate = state.ordinary;
    if (!candidate) {
      try {
        const names = await io.readdir(paths.parent);
        const name = names.find((entry) => !entry.includes('-incomplete-'));
        if (name) candidate = path.join(paths.parent, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT')
          throw error;
      }
    }
    if (candidate) await io.chmod(candidate, 0o700);
  } catch (error) {
    failures.push(error);
  }
  try {
    let recorded = state.staging;
    if (!recorded) {
      let text: string | undefined;
      try {
        text = await io.readFile(paths.manifest, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT')
          throw error;
      }
      if (text !== undefined)
        recorded = (JSON.parse(text) as { directory: string }).directory;
    }
    if (recorded) await io.rm(recorded, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      failures[0] instanceof Error ? failures[0].message : String(failures[0]),
      { cause: failures[0] }
    );
}

it('retains the original failure when cleanup finds no allocated parent or manifest', async () => {
  const fixture = createWorkflowFixture();
  fixtures.push(fixture);
  const parent = path.join(fixture.cwd, 'not-created');
  const manifest = path.join(fixture.support, 'not-created.json');
  const observation = new Error('Failure before allocation');
  const io = {
    chmod: vi.fn(recoveryIO.chmod),
    readdir: vi.fn(recoveryIO.readdir),
    readFile: vi.fn(recoveryIO.readFile),
    rm: vi.fn(recoveryIO.rm),
  };
  await expect(
    withRecoveryCleanup(
      { parent, manifest },
      async () => {
        throw observation;
      },
      io
    )
  ).rejects.toBe(observation);
  expect(io.readdir).toHaveBeenCalledExactlyOnceWith(parent);
  expect(io.readFile).toHaveBeenCalledExactlyOnceWith(manifest, 'utf8');
  expect(io.chmod).not.toHaveBeenCalled();
  expect(io.rm).not.toHaveBeenCalled();
});
it.each([
  'discovery',
  'repair',
  'manifest-read',
  'manifest-parse',
  'removal',
] as const)(
  'retains observation and genuine %s failure while draining recovery cleanup',
  async (fault) => {
    const fixture = createWorkflowFixture();
    fixtures.push(fixture);
    const parent = path.join(fixture.cwd, 'reports');
    const ordinary = path.join(parent, 'ordinary');
    const staging = path.join(fixture.support, 'staging');
    const manifest = path.join(fixture.support, 'staging.json');
    await mkdir(ordinary, { recursive: true });
    await mkdir(staging);
    await writeFile(manifest, JSON.stringify({ directory: staging }));
    const observation = new Error('Original verification assertion');
    const secondary = Object.assign(new Error(`Controlled ${fault} failure`), {
      code: 'EACCES',
    });
    const io = {
      chmod: vi.fn(recoveryIO.chmod),
      readdir: vi.fn(recoveryIO.readdir),
      readFile: vi.fn(recoveryIO.readFile),
      rm: vi.fn(recoveryIO.rm),
    };
    if (fault === 'discovery') io.readdir.mockRejectedValueOnce(secondary);
    if (fault === 'repair') io.chmod.mockRejectedValueOnce(secondary);
    if (fault === 'manifest-read') io.readFile.mockRejectedValueOnce(secondary);
    if (fault === 'manifest-parse')
      await writeFile(manifest, 'malformed manifest');
    if (fault === 'removal') io.rm.mockRejectedValueOnce(secondary);
    try {
      const outcome = await withRecoveryCleanup(
        { parent, manifest },
        async () => {
          throw observation;
        },
        io
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(outcome).toBeInstanceOf(AggregateError);
      const aggregate = outcome as AggregateError;
      expect(aggregate.message).toBe(observation.message);
      expect(aggregate.cause).toBe(observation);
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(observation);
      if (fault === 'manifest-parse')
        expect(aggregate.errors[1]).toBeInstanceOf(SyntaxError);
      else expect(aggregate.errors[1]).toBe(secondary);
      expect(io.readFile).toHaveBeenCalledExactlyOnceWith(manifest, 'utf8');
      if (fault === 'discovery' || fault === 'repair')
        await expect(stat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect((await stat(staging)).isDirectory()).toBe(true);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
);
it('rethrows a sole cleanup failure unchanged after a successful observation', async () => {
  const failure = Object.assign(new Error('Discovery denied'), {
    code: 'EACCES',
  });
  const io = {
    chmod: vi.fn(recoveryIO.chmod),
    readdir: vi.fn(recoveryIO.readdir),
    readFile: vi.fn(recoveryIO.readFile),
    rm: vi.fn(recoveryIO.rm),
  };
  io.readdir.mockRejectedValueOnce(failure);
  io.readFile.mockRejectedValueOnce(
    Object.assign(new Error('Missing manifest'), { code: 'ENOENT' })
  );
  await expect(
    withRecoveryCleanup(
      { parent: '/synthetic/reports', manifest: '/synthetic/manifest' },
      async () => {},
      io
    )
  ).rejects.toBe(failure);
  expect(io.readFile).toHaveBeenCalledOnce();
});

async function verifyRecoveryMode(
  mask: number,
  setgid: boolean,
  mode?: number,
  listRecovery: (directory: string) => Promise<string[]> = readdir
) {
  const fixture = createWorkflowFixture();
  fixtures.push(fixture);
  const parent = path.join(fixture.cwd, 'test-results', 'task-verification');
  const manifest = path.join(fixture.support, 'staging.json');
  await writeFile(
    path.join(fixture.bin, 'pnpm'),
    `#!${process.execPath}\nprocess.stdout.write('controlled step output\\n');\n`,
    { mode: 0o700 }
  );
  const entry = path.join(fixture.support, 'recovery.mjs');
  await writeFile(
    entry,
    `
import io from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
process.umask(${mask});
await io.mkdir(${JSON.stringify(parent)}, { recursive: true });
${setgid ? `await io.chmod(${JSON.stringify(parent)}, 0o2775);` : ''}
const write = io.writeFile.bind(io), remove = io.rm.bind(io), temporary = io.mkdtemp.bind(io), mkdir = io.mkdir.bind(io);
${
  mode === undefined
    ? ''
    : `io.mkdir = async (...args) => {
  const result = await mkdir(...args);
  if (path.dirname(String(args[0])) === ${JSON.stringify(parent)})
    await io.chmod(args[0], ${mode});
  return result;
};`
}
io.mkdtemp = async (...args) => {
  const directory = await temporary(...args);
  if (String(args[0]).includes('selective-designer-verification-'))
    await write(${JSON.stringify(manifest)}, JSON.stringify({ directory }));
  return directory;
};
io.writeFile = async (...args) => {
  if (path.basename(String(args[0])) === 'summary.md') throw new Error('Controlled final summary failure');
  return write(...args);
};
io.rm = async (...args) => {
  if (path.basename(String(args[0])) === 'summary.md') throw new Error('Controlled stale summary removal failure');
  return remove(...args);
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(path.resolve('scripts/task-verify.mjs')).href)});
`
  );
  await withRecoveryCleanup({ parent, manifest }, async (state) => {
    const result = await runFixtureCommand(process.execPath, [entry], fixture, {
      env: fixtureEnvironment(fixture),
      timeoutMs: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const reports = await readdir(parent);
    state.ordinary = path.join(
      parent,
      reports.find((name) => !name.includes('-incomplete-'))!
    );
    const recovery = path.join(
      parent,
      reports.find((name) => name.includes('-incomplete-'))!
    );
    const metadata = JSON.parse(await readFile(manifest, 'utf8')) as {
      directory: string;
    };
    state.staging = metadata.directory;
    const [originalStat, recoveryStat, stagingStat] = await Promise.all([
      stat(state.ordinary),
      stat(recovery),
      stat(state.staging),
    ]);
    const originalMode = mode ?? (0o777 & ~mask) | (setgid ? 0o2000 : 0);
    const expected = 0o700 | (originalMode & 0o3075);
    expect(originalStat.mode & 0o7777).toBe(originalMode);
    expect(recoveryStat.mode & 0o7777).toBe(expected);
    expect(recoveryStat.gid).toBe(originalStat.gid);
    expect(stagingStat.mode & 0o777).toBe(0o700);
    expect((await listRecovery(recovery)).sort()).toEqual([
      'check.log',
      'format-changed.log',
      'test.log',
    ]);
    expect(result.stderr).toContain(
      `Incomplete verification artifacts: ${recovery}; retained staging: ${state.staging}`
    );
    expect(result.stderr).not.toContain('artifacts: undefined');
  });
}
it.skipIf(process.platform === 'win32').each([
  { label: '0o022', mask: 0o022 },
  { label: '0o077', mask: 0o077 },
])(
  'prepares recovery under isolated process umask $label',
  ({ mask }) => verifyRecoveryMode(mask, false),
  20000
);
it.skipIf(process.platform === 'win32').each([
  { label: '0o000', mode: 0o000 },
  { label: '0o555', mode: 0o555 },
  { label: '0o777', mode: 0o777 },
  { label: '0o1777', mode: 0o1777 },
])(
  'publishes real logs from inaccessible or permissive report mode $label',
  ({ mode }) =>
    verifyRecoveryMode(0o022, false, mode, async (directory) =>
      (await readdir(directory)).reverse()
    ),
  20000
);
it.runIf(process.platform === 'linux')(
  'preserves real Linux setgid inheritance in recovery directories',
  () => verifyRecoveryMode(0o022, true),
  20000
);
