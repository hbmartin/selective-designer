import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, describe, expect, it } from 'vitest';
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

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runShell(script: string, cwd: string) {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      PATH: `${path.join(cwd, 'node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: os.homedir(),
      TMPDIR: os.tmpdir(),
      npm_config_verify_deps_before_run: 'false',
    },
  });
}

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

function git(root: string, args: string[]) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Workflow Fixture',
      '-c',
      'user.email=workflow@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: root, encoding: 'utf8', timeout: 5_000 }
  );
  assert.strictEqual(result.status, 0, result.stderr);
}

function changeTrackedFixture(root: string, staged: boolean) {
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'changed\n');
  if (staged) git(root, ['add', 'tracked.txt']);
}

describe('test workflow gates', () => {
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

it.each([
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
  ({ assertion, exitCode, failures }) => {
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
    assert(process.env.npm_execpath, 'Run workflow fixtures with pnpm');
    fs.symlinkSync(
      process.env.npm_execpath,
      path.join(root, 'node_modules/.bin/pnpm')
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
    const result = runShell(
      String(findStep(steps, 'Run PostgreSQL integration tests').run),
      root
    );
    assert(
      fs.readFileSync(metadataPath).equals(installedModules),
      'The reporter fixture must not modify the workspace installation'
    );
    assert.strictEqual(
      result.status,
      exitCode,
      `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`
    );
    const reportCheck = runShell(
      String(findStep(steps, 'Ensure JUnit report was generated').run),
      root
    );
    assert.strictEqual(reportCheck.status, 0, reportCheck.stderr);
    const junit = fs.readFileSync(
      path.join(root, 'test-results/vitest-postgres/junit.xml'),
      'utf8'
    );
    expect(junit).toContain('reporter fixture');
    expect(junit).toContain(failures);
  },
  20_000
);

it.each([
  { job: 'coverage', staged: false },
  { job: 'coverage', staged: true },
  { job: 'postgres-integration', staged: false },
  { job: 'postgres-integration', staged: true },
])(
  'rejects tracked changes for $job with staged=$staged',
  ({ job, staged }) => {
    const root = makeFixture();
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
    const command = String(
      findStep(readJobSteps(job), 'Ensure tests did not mutate tracked files')
        .run
    );
    expect(runShell(command, root).status).toBe(0);
    changeTrackedFixture(root, staged);
    expect(runShell(command, root).status).toBe(1);
  }
);
