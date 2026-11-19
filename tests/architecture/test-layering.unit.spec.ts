import {
  createWorkflowFixture,
  describeCommand,
  disposeWorkflowFixtures,
  runFixtureCommand,
  type WorkflowFixture,
} from '@tests/support/workflow-fixtures';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, assert, expect, it, vi } from 'vitest';

const extensions = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];
const fixtures: WorkflowFixture[] = [];
const checker = path.resolve('scripts/check-test-layering.mjs');
function makeFixture() {
  const fixture = createWorkflowFixture();
  fixtures.push(fixture);
  fs.mkdirSync(path.join(fixture.cwd, 'src'));
  fs.mkdirSync(path.join(fixture.cwd, 'tests'));
  return fixture;
}
afterEach(async () => {
  await disposeWorkflowFixtures(fixtures, () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
});
function write(fixture: WorkflowFixture, file: string, source: string) {
  const target = path.join(fixture.cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}
function check(fixture: WorkflowFixture, signal: AbortSignal) {
  return runFixtureCommand(process.execPath, [checker], fixture, {
    timeoutMs: 5_000,
    signal,
  });
}

it(
  'accepts all eight integration extensions, public workflow gates and adapter imports without executing files',
  { timeout: 10_000 },
  async ({ signal }) => {
    const fixture = makeFixture();
    for (const extension of extensions) {
      for (const directory of ['', 'nested/']) {
        for (const gate of ['index', 'server', 'client', 'presentation']) {
          for (const suffix of ['workflow', 'workflow.postgres']) {
            write(
              fixture,
              `tests/integration/${directory}${gate}.${suffix}.integration.test.${extension}`,
              `import { sample } from '@/modules/example/${gate}'; throw new Error('must not execute');`
            );
          }
        }
      }
      write(
        fixture,
        `tests/integration/native.postgres.integration.test.${extension}`,
        `import { sample } from '@/modules/example/infrastructure/private'; throw new Error('must not execute');`
      );
    }
    const result = await check(fixture, signal);
    assert.strictEqual(result.status, 0, describeCommand(result));
    expect(result.stdout).toContain('Test layering check passed');
  }
);

it(
  'rejects alias, relative and CommonJS workflow deep imports for every integration extension',
  { timeout: 10_000 },
  async ({ signal }) => {
    const fixture = makeFixture();
    const files: string[] = [];
    for (const extension of extensions) {
      for (const [kind, source] of [
        [
          'alias',
          "import { sample } from '@/modules/example/infrastructure/private';",
        ],
        [
          'relative',
          "import { sample } from '../../src/modules/example/domain/private';",
        ],
        [
          'commonjs',
          "const sample = require('@/modules/example/application/private');",
        ],
      ]) {
        const file = `tests/integration/${kind}.workflow.postgres.integration.test.${extension}`;
        files.push(file);
        write(fixture, file, source ?? '');
      }
    }
    const result = await check(fixture, signal);
    assert.strictEqual(result.status, 1, describeCommand(result));
    for (const file of files)
      expect(result.stderr).toContain(
        `${file}: workflow integration tests must import example through`
      );
  }
);

it(
  'rejects unsupported integration filenames without expanding the accepted gate policy',
  { timeout: 10_000 },
  async ({ signal }) => {
    const fixture = makeFixture();
    const files = [
      ...['mtsx', 'ctsx', 'mjsx', 'cjsx'].map(
        (extension) =>
          `tests/integration/unsupported.integration.test.${extension}`
      ),
      'tests/integration/wrong.integration.spec.ts',
    ];
    for (const file of files)
      write(fixture, file, "throw new Error('not executed');");
    write(
      fixture,
      'tests/integration/backend.workflow.integration.test.ts',
      "import { x } from '@/modules/example/backend';"
    );
    write(
      fixture,
      'tests/integration/ambiguous.postgres.workflow.integration.test.ts',
      ''
    );
    const result = await check(fixture, signal);
    assert.strictEqual(result.status, 1, describeCommand(result));
    expect(result.stderr).toContain(
      'ambiguous.postgres.workflow.integration.test.ts: PostgreSQL workflow tests must use .workflow.postgres.integration.test'
    );
    for (const file of files)
      expect(result.stderr).toContain(
        `${file}: integration tests must end with .integration.test`
      );
    expect(result.stderr).toContain(
      'backend.workflow.integration.test.ts: workflow integration tests must import example through'
    );
  }
);

it(
  'retains property-test placement and direct fast-check rules across the existing unit extension family',
  { timeout: 10_000 },
  async ({ signal }) => {
    const fixture = makeFixture();
    for (const extension of [...extensions, 'mtsx', 'ctsx', 'mjsx', 'cjsx']) {
      for (const suffix of ['spec', 'test']) {
        write(
          fixture,
          `tests/unit/modules/example/domain/__tests__/bad.unit.${suffix}.${extension}`,
          "import { fc } from '@tests/support/property-testing';"
        );
        write(
          fixture,
          `tests/unit/direct.unit.${suffix}.${extension}`,
          "import { fc } from '@fast-check/vitest';"
        );
      }
    }
    const result = await check(fixture, signal);
    assert.strictEqual(result.status, 1, describeCommand(result));
    for (const extension of [...extensions, 'mtsx', 'ctsx', 'mjsx', 'cjsx']) {
      for (const suffix of ['spec', 'test']) {
        expect(result.stderr).toContain(
          `bad.unit.${suffix}.${extension}: property-based domain unit tests must sit next to the source file`
        );
        expect(result.stderr).toContain(
          `direct.unit.${suffix}.${extension}: import property-test helpers`
        );
      }
    }
  }
);
