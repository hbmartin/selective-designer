import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createVitest } from 'vitest/node';

it('discovers ordinary integration specs while excluding PostgreSQL and nested tool directories', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-discovery-'))
  );
  const ordinary = [
    'tests/integration/ordinary.integration.test.ts',
    'tests/integration/nested/ordinary.integration.test.mts',
  ];
  const excluded = [
    'tests/integration/nested/driver.postgres.integration.test.ts',
    'tests/integration/nested/node_modules/pkg/vendor.integration.test.ts',
    'tests/integration/nested/.git/metadata.integration.test.ts',
  ];
  for (const file of [...ordinary, ...excluded]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      "throw new Error('Discovery must not execute tests');"
    );
  }

  try {
    const context = await createVitest({
      config: path.resolve('vitest.config.ts'),
      root,
      project: ['integration'],
      watch: false,
    });
    try {
      const specs = await context.globTestSpecifications();
      expect(
        specs.map((spec) => path.relative(root, spec.moduleId)).sort()
      ).toEqual(ordinary.sort());
    } finally {
      await context.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
