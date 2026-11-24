import { access, readFile, readdir, writeFile } from 'node:fs/promises';
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
