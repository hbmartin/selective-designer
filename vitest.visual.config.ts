import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const resolve = (filePath: string) => path.resolve(__dirname, filePath);
const visualViewport = { width: 1280, height: 900 } as const;
const visualSnapshotRoot = resolve('./__visual_snapshots__');

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
  optimizeDeps: {
    include: [
      '@base-ui/react/merge-props',
      '@base-ui/react/use-render',
      '@tanstack/react-router',
      'better-auth/client/plugins',
      'better-auth/plugins/access',
      'better-auth/plugins/admin/access',
      'better-auth/react',
    ],
  },
  test: {
    browser: {
      enabled: true,
      expect: {
        toMatchScreenshot: {
          comparatorName: 'pixelmatch',
          comparatorOptions: {
            allowedMismatchedPixelRatio: 0.001,
          },
          resolveScreenshotPath: ({
            arg,
            browserName,
            ext,
            platform,
            testFileDirectory,
            testFileName,
          }) =>
            path.join(
              visualSnapshotRoot,
              testFileDirectory,
              testFileName,
              `${arg}-${browserName}-${platform}${ext}`
            ),
        },
      },
      provider: playwright(),
      screenshotDirectory: '__visual_snapshots__',
      viewport: visualViewport,
      instances: [{ browser: 'chromium', viewport: visualViewport }],
    },
    include: ['tests/browser-visual/**/*.visual.spec.?(c|m)[jt]s?(x)'],
    name: 'browser-visual',
    setupFiles: [
      resolve('tests/setup.base.ts'),
      resolve('tests/setup.browser.ts'),
      resolve('tests/setup.browser-visual.ts'),
    ],
    testTimeout: 10_000,
  },
  resolve: {
    alias: testAliases,
  },
});
