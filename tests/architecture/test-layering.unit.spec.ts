import {
  createWorkflowFixture,
  describeCommand,
  disposeWorkflowFixture,
  runFixtureCommand,
  type WorkflowFixture,
} from '@tests/support/workflow-fixtures';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, assert, expect, it } from 'vitest';

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
  for (const fixture of fixtures.splice(0))
    await disposeWorkflowFixture(fixture);
});
function write(fixture: WorkflowFixture, file: string, source: string) {
  const target = path.join(fixture.cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}
function check(fixture: WorkflowFixture) {
  return runFixtureCommand(process.execPath, [checker], fixture);
}

it('accepts all eight integration extensions, public workflow gates and adapter imports without executing files', async () => {
  const fixture = makeFixture();
  for (const extension of extensions) {
    for (const gate of ['index', 'server', 'client', 'presentation']) {
      write(
        fixture,
        `tests/integration/${gate}.workflow.integration.test.${extension}`,
        `import { sample } from '@/modules/example/${gate}'; throw new Error('must not execute');`
      );
    }
    write(
      fixture,
      `tests/integration/native.postgres.integration.test.${extension}`,
      `import { sample } from '@/modules/example/infrastructure/private'; throw new Error('must not execute');`
    );
  }
  const result = await check(fixture);
  assert.strictEqual(result.status, 0, describeCommand(result));
  expect(result.stdout).toContain('Test layering check passed');
});

it('rejects alias, relative and CommonJS workflow deep imports for every integration extension', async () => {
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
      const file = `tests/integration/${kind}.postgres.workflow.integration.test.${extension}`;
      files.push(file);
      write(fixture, file, source ?? '');
    }
  }
  const result = await check(fixture);
  expect(result.status).toBe(1);
  for (const file of files)
    expect(result.stderr).toContain(
      `${file}: workflow integration tests must import example through`
    );
});

it('rejects unsupported integration filenames without expanding the accepted gate policy', async () => {
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
  const result = await check(fixture);
  expect(result.status).toBe(1);
  for (const file of files)
    expect(result.stderr).toContain(
      `${file}: integration tests must end with .integration.test`
    );
  expect(result.stderr).toContain(
    'backend.workflow.integration.test.ts: workflow integration tests must import example through'
  );
});

it('retains property-test placement and direct fast-check rules across the existing unit extension family', async () => {
  const fixture = makeFixture();
  for (const extension of [...extensions, 'mtsx', 'ctsx', 'mjsx', 'cjsx']) {
    write(
      fixture,
      `tests/unit/modules/example/domain/__tests__/bad.unit.spec.${extension}`,
      "import { fc } from '@tests/support/property-testing';"
    );
    write(
      fixture,
      `tests/unit/direct.unit.spec.${extension}`,
      "import { fc } from '@fast-check/vitest';"
    );
  }
  const result = await check(fixture);
  expect(result.status).toBe(1);
  for (const extension of [...extensions, 'mtsx', 'ctsx', 'mjsx', 'cjsx']) {
    expect(result.stderr).toContain(
      `bad.unit.spec.${extension}: property-based domain unit tests must sit next to the source file`
    );
    expect(result.stderr).toContain(
      `direct.unit.spec.${extension}: import property-test helpers`
    );
  }
});
