import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createVitest } from 'vitest/node';

it('separates ordinary and dedicated PostgreSQL discovery across supported extensions', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-discovery-'))
  );
  const extensions = ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx'];
  const ordinary = extensions.flatMap((extension) =>
    ['', 'nested/'].map(
      (directory) =>
        `tests/integration/${directory}ordinary.integration.test.${extension}`
    )
  );
  const postgres = extensions.flatMap((extension) =>
    ['', 'nested/'].map(
      (directory) =>
        `tests/integration/${directory}driver.postgres.integration.test.${extension}`
    )
  );
  const excluded = [
    ...['mtsx', 'ctsx', 'mjsx', 'cjsx'].flatMap((extension) => [
      `tests/integration/unsupported.integration.test.${extension}`,
      `tests/integration/unsupported.postgres.integration.test.${extension}`,
    ]),
    'tests/integration/nested/node_modules/pkg/vendor.integration.test.ts',
    'tests/integration/nested/.git/metadata.integration.test.ts',
    'tests/integration/nested/node_modules/pkg/vendor.postgres.integration.test.mts',
    'tests/integration/nested/.git/metadata.postgres.integration.test.ts',
  ];
  for (const file of [...ordinary, ...postgres, ...excluded]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      "throw new Error('Discovery must not execute tests');"
    );
  }

  try {
    for (const project of [
      {
        config: 'vitest.config.ts',
        project: ['integration'],
        expected: ordinary,
      },
      { config: 'vitest.postgres.config.ts', project: [], expected: postgres },
    ]) {
      const context = await createVitest({
        config: path.resolve(project.config),
        root,
        project: project.project,
        watch: false,
      });
      try {
        const specs = await context.globTestSpecifications();
        expect(
          specs.map((spec) => path.relative(root, spec.moduleId)).sort()
        ).toEqual(project.expected.toSorted());
      } finally {
        await context.close();
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
