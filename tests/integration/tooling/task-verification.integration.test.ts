import {
  access,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
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

async function verifyRecoveryMode(mask: number, setgid: boolean) {
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
const write = io.writeFile.bind(io), remove = io.rm.bind(io), temporary = io.mkdtemp.bind(io);
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
  let staging: string | undefined;
  const failures: unknown[] = [];
  try {
    const result = await runFixtureCommand(process.execPath, [entry], fixture, {
      env: fixtureEnvironment(fixture),
      timeoutMs: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const reports = await readdir(parent);
    const ordinary = path.join(
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
    staging = metadata.directory;
    const [originalStat, recoveryStat, stagingStat] = await Promise.all([
      stat(ordinary),
      stat(recovery),
      stat(staging),
    ]);
    const expected = (0o777 & ~mask) | (setgid ? 0o2000 : 0);
    expect(originalStat.mode & 0o7777).toBe(expected);
    expect(recoveryStat.mode & 0o7777).toBe(expected);
    expect(recoveryStat.gid).toBe(originalStat.gid);
    expect(stagingStat.mode & 0o777).toBe(0o700);
    expect(await readdir(recovery)).toEqual([
      'check.log',
      'format-changed.log',
      'test.log',
    ]);
    expect(result.stderr).toContain(
      `Incomplete verification artifacts: ${recovery}; retained staging: ${staging}`
    );
    expect(result.stderr).not.toContain('artifacts: undefined');
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      const recorded =
        staging ??
        (await readFile(manifest, 'utf8').then(
          (text) => (JSON.parse(text) as { directory: string }).directory,
          () => undefined
        ));
      if (recorded) await rm(recorded, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      'Publication verification and cleanup failed',
      { cause: failures[0] }
    );
}
it.skipIf(process.platform === 'win32').each([0o022, 0o077])(
  'matches actual report and recovery modes under isolated process umask %s',
  (mask) => verifyRecoveryMode(mask, false),
  20000
);
it.runIf(process.platform === 'linux')(
  'preserves real Linux setgid inheritance in recovery directories',
  () => verifyRecoveryMode(0o022, true),
  20000
);
