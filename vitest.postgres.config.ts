import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

const resolve = (filePath: string) =>
  path.resolve(import.meta.dirname, filePath);

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/integration/**/*.postgres.integration.test.?(c|m)[jt]s?(x)',
    ],
    exclude: configDefaults.exclude,
    setupFiles: [resolve('./tests/setup.base.ts')],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 60_000,
  },
  resolve: {
    alias: [
      {
        find: '@',
        replacement: resolve('./src'),
      },
      {
        find: /^@tests\/(.*)$/,
        replacement: resolve('./tests/$1'),
      },
    ],
  },
});
