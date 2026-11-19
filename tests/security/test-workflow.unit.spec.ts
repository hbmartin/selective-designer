import {
  createWorkflowFixture,
  describeCommand,
  disposeFixtureCommands,
  disposeWorkflowFixture,
  fixtureEnvironment,
  fixtureGit as git,
  pnpmFixtureEnvironment,
  runFixtureCommand,
  runFixtureShell as runShell,
  type WorkflowFixture,
} from '@tests/support/workflow-fixtures';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

type YamlRecord = Record<string, unknown>;

const asRecord = (value: unknown): YamlRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as YamlRecord)
    : undefined;

const workflow = asRecord(
  parse(
    fs.readFileSync(
      path.join(process.cwd(), '.github/workflows/code-quality.yml'),
      'utf8'
    )
  )
);
const jobs = asRecord(workflow?.jobs) ?? {};
const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
) as { packageManager: string; scripts: Record<string, string> };

function readJobSteps(id: string) {
  const job = asRecord(jobs[id]);
  if (!job || !Array.isArray(job.steps)) {
    throw new Error(`Expected test workflow job "${id}" with steps.`);
  }

  return job.steps.flatMap((step) => {
    const record = asRecord(step);
    return record ? [record] : [];
  });
}

function findStep(steps: YamlRecord[], name: string) {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Expected workflow step "${name}".`);
  return step;
}

const attemptedTests =
  "${{ !cancelled() && (steps.tests.outcome == 'success' || steps.tests.outcome == 'failure') }}";
const fixtures: WorkflowFixture[] = [];

function makeFixture() {
  const fixture = createWorkflowFixture();
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fixture of fixtures.splice(0))
    await disposeWorkflowFixture(fixture);
  vi.restoreAllMocks();
});

function expectPostTestGuards(
  steps: YamlRecord[],
  testName: string,
  uploadName: string,
  report: string
) {
  const tests = findStep(steps, testName);
  const junit = findStep(steps, 'Ensure JUnit report was generated');
  const mutation = findStep(steps, 'Ensure tests did not mutate tracked files');
  const upload = findStep(steps, uploadName);
  expect(tests.id).toBe('tests');
  expect(junit.if).toBe(attemptedTests);
  expect(junit.run).toBe(`test -s ${report}`);
  expect(mutation.if).toBe(attemptedTests);
  expect(String(mutation.run).trim().split('\n')).toEqual([
    'git diff --exit-code -- .',
    'git diff --cached --exit-code -- .',
  ]);
  expect(steps.indexOf(junit)).toBeGreaterThan(steps.indexOf(tests));
  expect(steps.indexOf(mutation)).toBeGreaterThan(steps.indexOf(junit));
  expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(mutation));
  expect(upload.if).toBe('always()');
}

function initializeTrackedFixture(fixture: WorkflowFixture) {
  fs.writeFileSync(path.join(fixture.cwd, 'tracked.txt'), 'original\n');
  git(fixture, ['init', '--quiet']);
  git(fixture, ['add', '.']);
  const thread = process.env.CODEX_THREAD_ID ?? 'workflow-test-fixture';
  git(fixture, [
    'commit',
    '--quiet',
    '-m',
    `Create mutation guard fixture\n\nModel: automated workflow verification\nThread: ${thread}`,
  ]);
}

function reporterDeadline(parent: AbortSignal, timeoutMs = 70_000) {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`Reporter case deadline exceeded (${timeoutMs}ms)`)
      ),
    timeoutMs
  );
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    dispose: () => clearTimeout(timer),
  };
}

function readyPid(file: string) {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const pid = Number(text);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(pid) && pid > 1
    ? pid
    : undefined;
}

function stoppedState(result: {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}) {
  if (result.error) throw result.error;
  const state = result.stdout.trim();
  if (result.status === 1 && !state && !result.stderr.trim()) return true;
  if (result.status !== 0 || !state || result.stderr.trim()) {
    throw new Error(
      `Cannot inspect descendant: exit ${result.status}; ${result.stdout}; ${result.stderr}`
    );
  }
  return state.startsWith('Z');
}

function processStopped(pid: number) {
  return stoppedState(
    childProcess.spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
    })
  );
}

describe('test workflow gates', () => {
  it('requires architecture reports and retains guards after failed tests', () => {
    const steps = readJobSteps('architecture');
    expect(String(findStep(steps, 'Run architecture tests').run)).toContain(
      'pnpm exec vitest run --project=unit tests/architecture --reporter=default --reporter=junit --outputFile.junit=test-results/architecture/junit.xml'
    );
    expectPostTestGuards(
      steps,
      'Run architecture tests',
      'Upload architecture test report',
      'test-results/architecture/junit.xml'
    );
  });

  it('runs the full ordinary suite with coverage and retains failure reports', () => {
    const steps = readJobSteps('coverage');
    expect(manifest.scripts['test:coverage']).toBe('vitest run --coverage');
    const commands = String(findStep(steps, 'Run tests').run)
      .trim()
      .split('\n');
    expect(commands).toContain(
      'pnpm test:coverage --reporter=default --reporter=junit --outputFile.junit=test-results/vitest/junit.xml'
    );
    expectPostTestGuards(
      steps,
      'Run tests',
      'Upload Vitest reports and coverage',
      'test-results/vitest/junit.xml'
    );
    expect(
      findStep(steps, 'Ensure lcov report was generated').if
    ).toBeUndefined();
    const codecov = findStep(steps, 'Upload coverage to Codecov');
    expect(codecov.if).toBe("env.CODECOV_TOKEN != ''");
    expect(steps.indexOf(codecov)).toBeGreaterThan(
      steps.indexOf(
        findStep(steps, 'Ensure tests did not mutate tracked files')
      )
    );
  });

  it('runs dedicated PostgreSQL tests separately and retains failure reports', () => {
    const steps = readJobSteps('postgres-integration');
    expect(manifest.scripts['test:integration:postgres']).toBe(
      'vitest run --config vitest.postgres.config.ts'
    );
    const commands = String(
      findStep(steps, 'Run PostgreSQL integration tests').run
    )
      .trim()
      .split('\n');
    expect(commands).toContain(
      'pnpm test:integration:postgres --reporter=default --reporter=junit --outputFile.junit=test-results/vitest-postgres/junit.xml'
    );
    expectPostTestGuards(
      steps,
      'Run PostgreSQL integration tests',
      'Upload PostgreSQL integration test report',
      'test-results/vitest-postgres/junit.xml'
    );
  });
});

it.for([
  {
    label: 'passing',
    assertion: 'true',
    exitCode: 0,
    failures: 'failures="0"',
  },
  {
    label: 'failing',
    assertion: 'false',
    exitCode: 1,
    failures: 'failures="1"',
  },
])(
  'writes PostgreSQL JUnit for a $label test using the real workflow command',
  { timeout: 75_000 },
  async ({ assertion, exitCode, failures }, { signal }) => {
    const deadline = reporterDeadline(signal);
    try {
      const fixture = makeFixture();
      fs.mkdirSync(path.join(fixture.cwd, 'node_modules/.bin'), {
        recursive: true,
      });
      fs.symlinkSync(
        fs.realpathSync(path.resolve('node_modules/vitest')),
        path.join(fixture.cwd, 'node_modules/vitest'),
        'dir'
      );
      fs.symlinkSync(
        path.resolve('node_modules/.bin/vitest'),
        path.join(fixture.cwd, 'node_modules/.bin/vitest')
      );
      // Neither an absent launcher hint nor an npm parent may select the tool.
      vi.stubEnv(
        'npm_execpath',
        exitCode === 0 ? undefined : '/unrelated/npm-cli.js'
      );
      fs.writeFileSync(
        path.join(fixture.cwd, '.npmrc'),
        'verify-deps-before-run=false\n'
      );
      fs.writeFileSync(
        path.join(fixture.cwd, 'package.json'),
        JSON.stringify({
          private: true,
          type: 'module',
          packageManager: manifest.packageManager,
          scripts: {
            'test:integration:postgres':
              manifest.scripts['test:integration:postgres'],
          },
        })
      );
      fs.writeFileSync(
        path.join(fixture.cwd, 'vitest.postgres.config.ts'),
        "export default {test:{include:['fixture.test.js'],environment:'node'}};\n"
      );
      fs.writeFileSync(
        path.join(fixture.cwd, 'fixture.test.js'),
        `import {test,expect} from 'vitest'; test('reporter fixture',()=>expect(${assertion}).toBe(true));\n`
      );
      const steps = readJobSteps('postgres-integration');
      const metadataPath = path.resolve('node_modules/.modules.yaml');
      const installedModules = fs.readFileSync(metadataPath);
      const env = await pnpmFixtureEnvironment(
        fixture,
        manifest.packageManager,
        process.env,
        deadline.signal
      );
      const result = await runShell(
        String(findStep(steps, 'Run PostgreSQL integration tests').run),
        fixture,
        { env, timeoutMs: 60_000, signal: deadline.signal }
      );
      assert(
        fs.readFileSync(metadataPath).equals(installedModules),
        'The reporter fixture must not modify the workspace installation'
      );
      assert(
        !result.error && !result.timedOut && !result.aborted,
        describeCommand(result)
      );
      assert.strictEqual(result.status, exitCode, describeCommand(result));
      const reportCheck = await runShell(
        String(findStep(steps, 'Ensure JUnit report was generated').run),
        fixture,
        { signal: deadline.signal }
      );
      assert.strictEqual(reportCheck.status, 0, describeCommand(reportCheck));
      const junit = fs.readFileSync(
        path.join(fixture.cwd, 'test-results/vitest-postgres/junit.xml'),
        'utf8'
      );
      expect(junit).toContain('reporter fixture');
      expect(junit).toContain(failures);
    } finally {
      deadline.dispose();
    }
  }
);

it.each([
  { job: 'coverage', staged: false },
  { job: 'coverage', staged: true },
  { job: 'postgres-integration', staged: false },
  { job: 'postgres-integration', staged: true },
  { job: 'architecture', staged: false },
  { job: 'architecture', staged: true },
])(
  'rejects tracked changes for $job with staged=$staged',
  async ({ job, staged }) => {
    const fixture = makeFixture();
    initializeTrackedFixture(fixture);
    const command = String(
      findStep(readJobSteps(job), 'Ensure tests did not mutate tracked files')
        .run
    );
    expect((await runShell(command, fixture)).status).toBe(0);
    fs.writeFileSync(path.join(fixture.cwd, 'tracked.txt'), 'changed\n');
    if (staged) git(fixture, ['add', 'tracked.txt']);
    expect((await runShell(command, fixture)).status).toBe(1);
  }
);

it('isolates Git setup and mutation guards from inherited repository and configuration overrides', async () => {
  const victim = makeFixture();
  initializeTrackedFixture(victim);
  const victimHead = git(victim, ['rev-parse', 'HEAD']);
  const victimIndex = fs.readFileSync(path.join(victim.cwd, '.git/index'));
  const victimWorktree = fs.readFileSync(path.join(victim.cwd, 'tracked.txt'));
  const hostileHome = makeFixture();
  const hostileConfig = `[core]\n  worktree = ${victim.cwd}\n[alias]\n  status = !exit 91\n`;
  fs.writeFileSync(path.join(hostileHome.cwd, '.gitconfig'), hostileConfig);
  const systemConfig = path.join(hostileHome.cwd, 'system-gitconfig');
  fs.writeFileSync(systemConfig, hostileConfig);
  for (const directory of [
    path.join(hostileHome.cwd, '.config/git'),
    path.join(hostileHome.cwd, 'xdg/git'),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'ignore'), '*.txt\n');
    fs.writeFileSync(path.join(directory, 'attributes'), '*.txt ident\n');
  }
  vi.stubEnv('XDG_CONFIG_HOME', path.join(hostileHome.cwd, 'xdg'));
  vi.stubEnv('HOME', hostileHome.cwd);
  vi.stubEnv('GIT_DIR', path.join(victim.cwd, '.git'));
  vi.stubEnv('GIT_WORK_TREE', victim.cwd);
  vi.stubEnv('GIT_INDEX_FILE', path.join(victim.cwd, '.git/index'));
  vi.stubEnv('GIT_CONFIG_SYSTEM', systemConfig);
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(hostileHome.cwd, '.gitconfig'));
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.worktree');
  vi.stubEnv('GIT_CONFIG_VALUE_0', victim.cwd);
  vi.stubEnv('GIT_CONFIG_PARAMETERS', `'core.worktree=${victim.cwd}'`);

  const fixture = makeFixture();
  initializeTrackedFixture(fixture);
  expect(fs.realpathSync(git(fixture, ['rev-parse', '--show-toplevel']))).toBe(
    fs.realpathSync(fixture.cwd)
  );
  expect(git(fixture, ['ls-files'])).toBe('tracked.txt');
  expect(git(fixture, ['check-attr', 'ident', '--', 'tracked.txt'])).toBe(
    'tracked.txt: ident: unspecified'
  );
  const config = fixtureEnvironment(fixture).GIT_CONFIG_GLOBAL;
  assert(config);
  expect(fs.statSync(config).isFile()).toBe(true);
  expect(path.relative(fixture.cwd, config).startsWith('..')).toBe(true);
  git(fixture, ['config', '--global', 'fixture.owner', 'owned-support']);
  expect(fs.readFileSync(config, 'utf8')).toContain('owned-support');
  const command = String(
    findStep(
      readJobSteps('architecture'),
      'Ensure tests did not mutate tracked files'
    ).run
  );
  expect((await runShell(command, fixture)).status).toBe(0);
  fs.writeFileSync(path.join(fixture.cwd, 'tracked.txt'), 'changed\n');
  expect((await runShell(command, fixture)).status).toBe(1);
  git(fixture, ['add', 'tracked.txt']);
  expect((await runShell(command, fixture)).status).toBe(1);
  expect(git(victim, ['rev-parse', 'HEAD'])).toBe(victimHead);
  expect(fs.readFileSync(path.join(victim.cwd, '.git/index'))).toEqual(
    victimIndex
  );
  expect(fs.readFileSync(path.join(victim.cwd, 'tracked.txt'))).toEqual(
    victimWorktree
  );
});

it('reports missing or incompatible pnpm without skipping or installing tools', async () => {
  const fixture = makeFixture();
  const env = fixtureEnvironment(fixture);
  await expect(
    pnpmFixtureEnvironment(fixture, manifest.packageManager, {
      ...env,
      PATH: '',
    })
  ).rejects.toThrow('was not found on PATH');
  const executable = path.join(fixture.cwd, 'pnpm');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "0.0.0\\n"\n', {
    mode: 0o755,
  });
  const mismatch = await pnpmFixtureEnvironment(
    fixture,
    manifest.packageManager,
    {
      ...env,
      PATH: fixture.cwd,
    }
  ).catch((error: unknown) => error);
  expect(mismatch).toBeInstanceOf(Error);
  expect(String(mismatch)).toContain(
    `Expected ${manifest.packageManager.split('+')[0]?.replace('@', ' ')}`
  );
  expect(String(mismatch)).toContain('0.0.0');
});

it('reports bounded subprocess timeouts and spawn errors', async () => {
  const fixture = makeFixture();
  const result = await runFixtureCommand(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    fixture,
    { timeoutMs: 1_500, terminationGraceMs: 100 }
  );
  expect(result.timedOut).toBe(true);
  expect(result.signal).toMatch(/^SIG(TERM|KILL)$/);
  expect(describeCommand(result)).toContain('timeout: true');
  const missing = await runFixtureCommand(
    path.join(fixture.cwd, 'missing-command'),
    [],
    fixture
  );
  expect(missing.error).toMatchObject({ code: 'ENOENT' });
  expect(describeCommand(missing)).toContain('Spawn error: spawn');
});

it.for(['cancellation', 'disposal'])(
  'stops a subprocess group with a SIGTERM-ignoring descendant after %s',
  { timeout: 15_000 },
  async (mode, { signal }) => {
    const fixture = makeFixture();
    const ready = path.join(fixture.cwd, 'descendant.pid');
    const descendant = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); const fs = require('node:fs'); fs.writeSync(1, 'descendant ready\\n'); fs.writeSync(2, 'descendant stderr\\n'); fs.writeFileSync(${JSON.stringify(ready + '.tmp')}, String(process.pid)); fs.renameSync(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)});`;
    const script = `process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore', 'inherit', 'inherit']}); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const running = runFixtureCommand(
      process.execPath,
      ['-e', script],
      fixture,
      {
        signal: AbortSignal.any([signal, controller.signal]),
        timeoutMs: 10_000,
      }
    );
    try {
      await expect
        .poll(() => readyPid(ready), { timeout: 5_000, interval: 50 })
        .toBeDefined();
      const pid = readyPid(ready);
      assert(pid, 'Readiness must publish a positive PID');
      expect(processStopped(pid)).toBe(false);
      if (mode === 'disposal') await disposeFixtureCommands(fixture);
      else controller.abort();
      const result = await running;
      expect(result.aborted).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.stdout).toContain('descendant ready');
      expect(result.stderr).toContain('descendant stderr');
      await expect
        .poll(() => processStopped(pid), { timeout: 5_000, interval: 50 })
        .toBe(true);
    } finally {
      controller.abort();
      await running;
    }
  }
);

it.each(['', '0', '1', '-12', '12.5', '1e3', 'bad', '9007199254740992'])(
  'does not accept malformed or unsafe readiness PID %j',
  (text) => {
    const fixture = makeFixture();
    const file = path.join(fixture.cwd, 'pid');
    expect(readyPid(file)).toBeUndefined();
    fs.writeFileSync(file, text);
    expect(readyPid(file)).toBeUndefined();
    fs.writeFileSync(file, String(process.pid));
    expect(readyPid(file)).toBe(process.pid);
  }
);

it('distinguishes absent and zombie descendants from live processes and inspection errors', () => {
  expect(stoppedState({ status: 1, stdout: '', stderr: '' })).toBe(true);
  expect(stoppedState({ status: 0, stdout: 'Z+\n', stderr: '' })).toBe(true);
  expect(stoppedState({ status: 0, stdout: 'S+\n', stderr: '' })).toBe(false);
  expect(() =>
    stoppedState({ status: 2, stdout: '', stderr: 'bad options' })
  ).toThrow('Cannot inspect descendant');
  expect(() => stoppedState({ status: 0, stdout: '', stderr: '' })).toThrow(
    'Cannot inspect descendant'
  );
  expect(() =>
    stoppedState({ status: 1, stdout: '', stderr: 'permission denied' })
  ).toThrow('Cannot inspect descendant');
  expect(() =>
    stoppedState({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawn failed'),
    })
  ).toThrow('spawn failed');
});

it('never spawns a command whose signal is already aborted', async () => {
  const fixture = makeFixture();
  const spawn = vi.spyOn(childProcess, 'spawn');
  syncBuiltinESMExports();
  try {
    const result = await runFixtureCommand(
      process.execPath,
      ['-e', 'throw new Error("must not run")'],
      fixture,
      { signal: AbortSignal.abort('already cancelled') }
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      aborted: true,
      timedOut: false,
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      abortReason: 'already cancelled',
    });
    expect(result.error).toBeUndefined();
    const active = await runFixtureCommand(
      process.execPath,
      ['--version'],
      fixture
    );
    expect(active.status).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    spawn.mockRestore();
    syncBuiltinESMExports();
  }
});

it('shares the reporter deadline across successive command phases', async ({
  signal,
}) => {
  const fixture = makeFixture();
  const deadline = reporterDeadline(signal, 1_000);
  try {
    const first = await runFixtureCommand(
      '/bin/echo',
      ['first phase'],
      fixture,
      { signal: deadline.signal }
    );
    expect(first.status).toBe(0);
    const second = await runFixtureCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      fixture,
      { signal: deadline.signal, timeoutMs: 5_000 }
    );
    expect(second.aborted).toBe(true);
    expect(second.timedOut).toBe(false);
    expect(describeCommand(second)).toContain(
      'Reporter case deadline exceeded (1000ms)'
    );
  } finally {
    deadline.dispose();
  }
});
