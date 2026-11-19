type TestProjectDefinition = {
  execution: 'ordinary' | 'postgres';
  include: string[];
  exclude: string[];
  setupFiles: string[];
  globalSetup: string[];
};

// Keep test membership and implicit setup dependencies shared with discovery.
const defaultExclude = ['**/node_modules/**', '**/.git/**'];

export const vitestProjects = {
  browser: {
    execution: 'ordinary',
    include: ['tests/browser/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: defaultExclude,
    setupFiles: ['tests/setup.base.ts', 'tests/setup.browser.ts'],
    globalSetup: [],
  },
  unit: {
    execution: 'ordinary',
    include: [
      'tests/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'tests/architecture/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'tests/security/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    ],
    exclude: defaultExclude,
    setupFiles: ['tests/setup.base.ts', 'tests/server/test-setup.ts'],
    globalSetup: [],
  },
  integration: {
    execution: 'ordinary',
    include: ['tests/integration/**/*.integration.test.?(c|m)[jt]s?(x)'],
    exclude: ['tests/integration/**/*.postgres.integration.test.ts'],
    setupFiles: ['tests/setup.base.ts'],
    globalSetup: ['tests/server/pglite-global-setup.ts'],
  },
  postgres: {
    execution: 'postgres',
    include: ['tests/integration/**/*.postgres.integration.test.ts'],
    exclude: defaultExclude,
    setupFiles: ['tests/setup.base.ts'],
    globalSetup: [],
  },
} satisfies Record<string, TestProjectDefinition>;

export type TestProjectId = keyof typeof vitestProjects;

export const vitestProjectOptions = (
  id: TestProjectId,
  resolve: (file: string) => string
) => {
  const project = vitestProjects[id];
  return {
    include: project.include,
    exclude: project.exclude,
    setupFiles: project.setupFiles.map(resolve),
    globalSetup: project.globalSetup.map(resolve),
  };
};
