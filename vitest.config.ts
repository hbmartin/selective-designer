import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import path from 'node:path';
import { coverageConfigDefaults, defineConfig } from 'vitest/config';

import { vitestProjectOptions } from './scripts/vitest-projects';

const resolve = (filePath: string) =>
  path.resolve(import.meta.dirname, filePath);

const testAliases = [
  {
    find: /^@tanstack\/react-start$/,
    replacement: resolve('./tests/mocks/tanstack-react-start.ts'),
  },
  {
    find: /^@tanstack\/react-start\/server$/,
    replacement: resolve('./tests/mocks/tanstack-react-start-server.ts'),
  },
  {
    find: /^@tests\/(.*)$/,
    replacement: resolve('./tests/$1'),
  },
  {
    find: '@',
    replacement: resolve('./src'),
  },
];

export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      exclude: [...coverageConfigDefaults.exclude, 'src/app/i18n/**/*.json'],
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'lcov'],
    },
    projects: [
      {
        optimizeDeps: {
          include: [
            '@base-ui/react/merge-props',
            '@base-ui/react/menu',
            '@base-ui/react/use-render',
            '@tanstack/react-router',
            'better-auth/client/plugins',
            'better-auth/plugins/access',
            'better-auth/plugins/admin/access',
            'better-auth/react',
            'react-error-boundary',
          ],
        },
        test: {
          name: 'browser',
          browser: {
            enabled: true,
            provider: playwright({
              contextOptions: {
                permissions: ['clipboard-write', 'clipboard-read'],
              },
            }),
            instances: [{ browser: 'chromium' }],
          },
          ...vitestProjectOptions('browser', resolve),
        },
        resolve: {
          alias: testAliases,
        },
      },
      {
        test: {
          name: 'unit',
          environment: 'node',
          ...vitestProjectOptions('unit', resolve),
        },
        resolve: {
          alias: testAliases,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          ...vitestProjectOptions('integration', resolve),
          fileParallelism: false,
        },
        resolve: {
          alias: testAliases,
        },
      },
    ],
  },
});
