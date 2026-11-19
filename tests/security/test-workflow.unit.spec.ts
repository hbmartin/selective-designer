import {
  describeCommand,
  disposeFixtureCommands,
  fixtureEnvironment,
  fixtureGit as git,
  pnpmFixtureEnvironment,
  runFixtureCommand,
  runFixtureShell as runShell,
} from '@tests/support/workflow-fixtures';
import fs from 'node:fs';
import os from 'node:os';
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
const temporaryDirectories: string[] = [];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-workflow-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of temporaryDirectories.splice(0)) {
    await disposeFixtureCommands(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
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

function initializeTrackedFixture(root: string) {
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  git(root, ['init', '--quiet']);
  git(root, ['add', '.']);
  const thread = process.env.CODEX_THREAD_ID ?? 'workflow-test-fixture';
  git(root, [
    'commit',
    '--quiet',
    '-m',
    `Create mutation guard fixture\n\nModel: automated workflow verification\nThread: ${thread}`,
  ]);
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
    const root = makeFixture();
    fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
    fs.symlinkSync(
      fs.realpathSync(path.resolve('node_modules/vitest')),
      path.join(root, 'node_modules/vitest'),
      'dir'
    );
    fs.symlinkSync(
      path.resolve('node_modules/.bin/vitest'),
      path.join(root, 'node_modules/.bin/vitest')
    );
    // Neither an absent launcher hint nor an npm parent may select the tool.
    vi.stubEnv(
      'npm_execpath',
      exitCode === 0 ? undefined : '/unrelated/npm-cli.js'
    );
    fs.writeFileSync(
      path.join(root, '.npmrc'),
      'verify-deps-before-run=false\n'
    );
    fs.writeFileSync(
      path.join(root, 'package.json'),
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
      path.join(root, 'vitest.postgres.config.ts'),
      "export default {test:{include:['fixture.test.js'],environment:'node'}};\n"
    );
    fs.writeFileSync(
      path.join(root, 'fixture.test.js'),
      `import {test,expect} from 'vitest'; test('reporter fixture',()=>expect(${assertion}).toBe(true));\n`
    );
    const steps = readJobSteps('postgres-integration');
    const metadataPath = path.resolve('node_modules/.modules.yaml');
    const installedModules = fs.readFileSync(metadataPath);
    const env = await pnpmFixtureEnvironment(
      root,
      manifest.packageManager,
      fixtureEnvironment(root),
      signal
    );
    const result = await runShell(
      String(findStep(steps, 'Run PostgreSQL integration tests').run),
      root,
      { env, timeoutMs: 60_000, signal }
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
      root,
      { signal }
    );
    assert.strictEqual(reportCheck.status, 0, describeCommand(reportCheck));
    const junit = fs.readFileSync(
      path.join(root, 'test-results/vitest-postgres/junit.xml'),
      'utf8'
    );
    expect(junit).toContain('reporter fixture');
    expect(junit).toContain(failures);
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
    const root = makeFixture();
    initializeTrackedFixture(root);
    const command = String(
      findStep(readJobSteps(job), 'Ensure tests did not mutate tracked files')
        .run
    );
    expect((await runShell(command, root)).status).toBe(0);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'changed\n');
    if (staged) git(root, ['add', 'tracked.txt']);
    expect((await runShell(command, root)).status).toBe(1);
  }
);

it('isolates Git setup and mutation guards from inherited repository and configuration overrides', async () => {
  const victim = makeFixture();
  initializeTrackedFixture(victim);
  const victimHead = git(victim, ['rev-parse', 'HEAD']);
  const victimIndex = fs.readFileSync(path.join(victim, '.git/index'));
  const victimWorktree = fs.readFileSync(path.join(victim, 'tracked.txt'));
  const hostileHome = makeFixture();
  const hostileConfig = `[core]\n  worktree = ${victim}\n[alias]\n  status = !exit 91\n`;
  fs.writeFileSync(path.join(hostileHome, '.gitconfig'), hostileConfig);
  const systemConfig = path.join(hostileHome, 'system-gitconfig');
  fs.writeFileSync(systemConfig, hostileConfig);
  vi.stubEnv('HOME', hostileHome);
  vi.stubEnv('GIT_DIR', path.join(victim, '.git'));
  vi.stubEnv('GIT_WORK_TREE', victim);
  vi.stubEnv('GIT_INDEX_FILE', path.join(victim, '.git/index'));
  vi.stubEnv('GIT_CONFIG_SYSTEM', systemConfig);
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(hostileHome, '.gitconfig'));
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.worktree');
  vi.stubEnv('GIT_CONFIG_VALUE_0', victim);
  vi.stubEnv('GIT_CONFIG_PARAMETERS', `'core.worktree=${victim}'`);

  const root = makeFixture();
  initializeTrackedFixture(root);
  expect(fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']))).toBe(
    fs.realpathSync(root)
  );
  const command = String(
    findStep(
      readJobSteps('architecture'),
      'Ensure tests did not mutate tracked files'
    ).run
  );
  expect((await runShell(command, root)).status).toBe(0);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'changed\n');
  expect((await runShell(command, root)).status).toBe(1);
  git(root, ['add', 'tracked.txt']);
  expect((await runShell(command, root)).status).toBe(1);
  expect(git(victim, ['rev-parse', 'HEAD'])).toBe(victimHead);
  expect(fs.readFileSync(path.join(victim, '.git/index'))).toEqual(victimIndex);
  expect(fs.readFileSync(path.join(victim, 'tracked.txt'))).toEqual(
    victimWorktree
  );
});

it('reports missing or incompatible pnpm without skipping or installing tools', async () => {
  const root = makeFixture();
  const env = fixtureEnvironment(root);
  await expect(
    pnpmFixtureEnvironment(root, manifest.packageManager, { ...env, PATH: '' })
  ).rejects.toThrow('was not found on PATH');
  const executable = path.join(root, 'pnpm');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "0.0.0\\n"\n', {
    mode: 0o755,
  });
  const mismatch = await pnpmFixtureEnvironment(root, manifest.packageManager, {
    ...env,
    PATH: root,
  }).catch((error: unknown) => error);
  expect(mismatch).toBeInstanceOf(Error);
  expect(String(mismatch)).toContain(
    `Expected ${manifest.packageManager.split('+')[0]?.replace('@', ' ')}`
  );
  expect(String(mismatch)).toContain('0.0.0');
});

it('reports bounded subprocess timeouts and spawn errors', async () => {
  const root = makeFixture();
  const result = await runFixtureCommand(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    root,
    { timeoutMs: 1_500, terminationGraceMs: 100 }
  );
  expect(result.timedOut).toBe(true);
  expect(result.signal).toMatch(/^SIG(TERM|KILL)$/);
  expect(describeCommand(result)).toContain('timeout: true');
  const missing = await runFixtureCommand(
    path.join(root, 'missing-command'),
    [],
    root
  );
  expect(missing.error).toMatchObject({ code: 'ENOENT' });
  expect(describeCommand(missing)).toContain('Spawn error: spawn');
});

it.for(['cancellation', 'disposal'])(
  'stops a subprocess group with a SIGTERM-ignoring descendant after %s',
  { timeout: 15_000 },
  async (mode, { signal }) => {
    const root = makeFixture();
    const ready = path.join(root, 'descendant.pid');
    const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); console.log('descendant ready'); console.error('descendant stderr'); setInterval(() => {}, 1000);`;
    const script = `process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore', 'inherit', 'inherit']}); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const running = runFixtureCommand(process.execPath, ['-e', script], root, {
      signal: AbortSignal.any([signal, controller.signal]),
      timeoutMs: 10_000,
      terminationGraceMs: 100,
    });
    try {
      await expect.poll(() => fs.existsSync(ready)).toBe(true);
      const pid = Number(fs.readFileSync(ready, 'utf8'));
      if (mode === 'disposal') await disposeFixtureCommands(root);
      else controller.abort();
      const result = await running;
      expect(result.aborted).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.stdout).toContain('descendant ready');
      expect(result.stderr).toContain('descendant stderr');
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
        })
        .toBe(true);
    } finally {
      controller.abort();
      await running;
    }
  }
);
