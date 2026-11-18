import path from 'node:path';
import { defineConfig } from 'vitest/config';

import { vitestProjectOptions } from './scripts/vitest-projects';

const resolve = (filePath: string) =>
  path.resolve(import.meta.dirname, filePath);

export default defineConfig({
  test: {
    environment: 'node',
    ...vitestProjectOptions('postgres', resolve),
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
