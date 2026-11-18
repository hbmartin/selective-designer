import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type AffectedTestsResult,
  buildVitestCommand,
  classifyChangedFiles,
  collectChangedFilesFromGit,
  computeMirrorTestPaths,
  deduplicateAndSort,
  type DependencyCruiserReport,
  findAffectedTests,
  findRelatedTestsInGraph,
  formatOutput,
  isCliEntrypoint,
  main,
  normalizePath,
  POSTGRES_SETUP_FILES,
  parseCliArguments,
  parseNullDelimitedPaths,
  runStrategyB,
  runVitest,
} from '../../../scripts/affected-tests';
import postgresConfig from '../../../vitest.postgres.config';

const tempDirectories: string[] = [];

const makeTempCwd = (files: string[]) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-tests-'));
  tempDirectories.push(cwd);

  for (const file of files) {
    const absolutePath = path.join(cwd, file);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, '', 'utf8');
  }

  return cwd;
};

const makeResult = (
  overrides: Partial<AffectedTestsResult> = {}
): AffectedTestsResult => ({
  changedFiles: [],
  consideredSourceFiles: [],
  dependencyCruiserFailed: false,
  directTestFiles: [],
  excludedChangedFiles: [],
  postgresTestFiles: [],
  postgresImpactReasons: [],
  rootsCruised: [],
  runAll: false,
  strategyAFiles: [],
  strategyBFiles: [],
  testFiles: [],
  warnings: [],
  ...overrides,
});

const runGitForLocalChangeFixture = (args: string[]) => {
  const command = args.join(' ');
  switch (command) {
    case 'diff --name-only --diff-filter=ACMRTD -z':
      return 'src/a.ts\0';
    case 'diff --cached --name-only --diff-filter=ACMRTD -z':
      return 'src/b.ts\0src/a.ts\0';
    case 'ls-files --others --exclude-standard -z':
      return 'tests/unit/a.unit.spec.ts\0';
    default:
      throw new Error(command);
  }
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

describe('affected test CLI argument parsing', () => {
  it('parses supported flags and tolerates a standalone separator', () => {
    expect(
      parseCliArguments(['--', '--base', 'origin/main', '--run', '--verbose'])
    ).toEqual({
      ok: true,
      options: {
        base: 'origin/main',
        help: false,
        json: false,
        run: true,
        summary: false,
        verbose: true,
      },
    });
  });

  it('rejects invalid flag combinations and missing values', () => {
    expect(parseCliArguments(['--wat'])).toEqual({
      error: 'Unknown option: --wat',
      ok: false,
    });
    expect(parseCliArguments(['--base'])).toEqual({
      error: 'Missing value for --base.',
      ok: false,
    });
    expect(parseCliArguments(['--json', '--summary'])).toEqual({
      error: 'Use either --json or --summary, not both.',
      ok: false,
    });
  });
});

describe('changed file discovery helpers', () => {
  it('normalizes null-delimited git output', () => {
    expect(
      parseNullDelimitedPaths(
        './src\\modules\\design\\domain\\design.ts\0src/modules/design/domain/design.ts\0\0README.md\0'
      )
    ).toEqual(['README.md', 'src/modules/design/domain/design.ts']);
  });

  it('uses the triple-dot base diff when a base is provided', () => {
    const calls: Array<{ args: string[]; description: string }> = [];
    const files = collectChangedFilesFromGit({
      base: 'origin/main',
      runGit: (args, description) => {
        calls.push({ args, description });
        return 'src/router.tsx\0';
      },
    });

    expect(files).toEqual(['src/router.tsx']);
    expect(calls).toEqual([
      {
        args: [
          'diff',
          'origin/main...HEAD',
          '--name-only',
          '--diff-filter=ACMRTD',
          '-z',
        ],
        description: 'git diff origin/main...HEAD',
      },
    ]);
  });

  it('combines unstaged, staged, and untracked local changes', () => {
    const files = collectChangedFilesFromGit({
      runGit: runGitForLocalChangeFixture,
    });

    expect(files).toEqual([
      'src/a.ts',
      'src/b.ts',
      'tests/unit/a.unit.spec.ts',
    ]);
  });
});

describe('changed file classification', () => {
  it('separates source, direct tests, test support, global config, and exclusions', () => {
    expect(
      classifyChangedFiles([
        'vitest.config.ts',
        'src/modules/design/domain/design.ts',
        'scripts/affected-tests.ts',
        'tests/unit/modules/design/domain/design.unit.spec.ts',
        'tests/browser/platform/components/form/form.browser.spec.tsx',
        'tests/integration/modules/design/infrastructure/__tests__/design-repository-drizzle.postgres.integration.test.ts',
        'tests/e2e/login.spec.ts',
        'tests/server/test-utils.ts',
        'README.md',
      ])
    ).toEqual({
      directTestFiles: [
        'tests/browser/platform/components/form/form.browser.spec.tsx',
        'tests/unit/modules/design/domain/design.unit.spec.ts',
      ],
      excludedFiles: [
        'README.md',
        'tests/e2e/login.spec.ts',
        'tests/integration/modules/design/infrastructure/__tests__/design-repository-drizzle.postgres.integration.test.ts',
      ],
      globalConfigChanged: true,
      globalConfigFiles: ['vitest.config.ts'],
      sourceFiles: [
        'scripts/affected-tests.ts',
        'src/modules/design/domain/design.ts',
      ],
      testSupportFiles: ['tests/server/test-utils.ts'],
    });
  });
});

describe('global config fallback', () => {
  it('runs all runnable Vitest tests without dependency graph discovery', async () => {
    const dependencyCruiser = vi.fn(async () => {
      throw new Error('should not run');
    });

    const result = await findAffectedTests({
      allTestFiles: [
        'tests/unit/a.unit.spec.ts',
        'tests/browser/a.browser.spec.tsx',
        './tests/unit/a.unit.spec.ts',
        'tests\\browser\\a.browser.spec.tsx',
        'tests/unit/README.md',
      ],
      changedFiles: ['vitest.config.ts'],
      dependencyCruiser,
    });

    expect(result.runAll).toBe(true);
    expect(result.runAllReason).toBe('global config file changed');
    expect(result.testFiles).toEqual([
      'tests/browser/a.browser.spec.tsx',
      'tests/unit/a.unit.spec.ts',
    ]);
    expect(result.warnings).toEqual([]);
    expect(dependencyCruiser).not.toHaveBeenCalled();
  });

  it('does not select affected Vitest tests for a PostgreSQL config-only edit', async () => {
    const dependencyCruiser = vi.fn();
    const config = 'vitest.postgres.config.ts';
    const result = await findAffectedTests({
      changedFiles: [config],
      allTestFiles: [
        'tests/unit/a.unit.spec.ts',
        'tests/integration/a.postgres.integration.test.ts',
      ],
      dependencyCruiser,
    });

    expect(result.runAll).toBe(false);
    expect(result.excludedChangedFiles).toEqual([config]);
    expect(result.testFiles).toEqual([]);
    expect(result.warnings).toEqual([
      'PostgreSQL checks may be affected. Run pnpm test:integration:postgres to verify them. Reason: PostgreSQL configuration changed.',
    ]);
    expect(
      JSON.parse(
        formatOutput(result, {
          json: true,
          summary: false,
          verbose: false,
        })
      ).warnings
    ).toEqual(result.warnings);
    expect(dependencyCruiser).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL guidance', () => {
  const postgresTest =
    'tests/integration/repository.postgres.integration.test.ts';
  const source = 'src/repository.ts';
  const unitTest = 'tests/unit/repository.unit.spec.ts';
  const warning =
    'PostgreSQL checks may be affected. Run pnpm test:integration:postgres to verify them.';
  const report: DependencyCruiserReport = {
    modules: [
      { source },
      { source: 'src/backend.ts', dependencies: [{ resolved: source }] },
      { source: postgresTest, dependencies: [{ resolved: 'src/backend.ts' }] },
      { source: unitTest, dependencies: [{ resolved: source }] },
    ],
  };

  it('models the setup files configured by the dedicated PostgreSQL suite', () => {
    const setupFiles = postgresConfig.test?.setupFiles;
    const configuredFiles =
      typeof setupFiles === 'string' ? [setupFiles] : (setupFiles ?? []);
    expect(
      deduplicateAndSort(
        configuredFiles.map((file) => path.relative(process.cwd(), file))
      )
    ).toEqual(deduplicateAndSort([...POSTGRES_SETUP_FILES]));
  });

  it.each([
    { file: 'drizzle/migrations/0012_example.sql', state: 'added' },
    { file: 'drizzle/migrations/0012_example.sql', state: 'edited' },
    { file: 'drizzle/migrations/0012_example.sql', state: 'deleted' },
    { file: 'drizzle/migrations/meta/_journal.json', state: 'added' },
    { file: 'drizzle/migrations/meta/_journal.json', state: 'edited' },
    { file: 'drizzle/migrations/meta/_journal.json', state: 'deleted' },
  ])(
    'warns for $state migration input $file without executing PostgreSQL specs',
    async ({ file, state }) => {
      const otherSpec =
        'tests/integration/another.postgres.integration.test.ts';
      const cwd = makeTempCwd([
        unitTest,
        postgresTest,
        otherSpec,
        ...(state === 'deleted' ? [] : [file]),
      ]);
      const dependencyCruiser = vi.fn();
      const result = await findAffectedTests({
        cwd,
        changedFiles: [file],
        dependencyCruiser,
      });
      expect(result.postgresImpactReasons).toEqual(['migration']);
      expect(result.postgresTestFiles).toEqual([otherSpec, postgresTest]);
      expect(result.testFiles).toEqual([]);
      expect(result.warnings).toEqual([
        `${warning} Reason: PostgreSQL migration inputs changed.`,
      ]);
      expect(dependencyCruiser).not.toHaveBeenCalled();
      const run = vi.fn();
      const stderr = vi.fn();
      await expect(
        main(['--run'], {
          findAffectedTests: async () => result,
          runVitest: run,
          stdout: vi.fn(),
          stderr,
        })
      ).resolves.toBe(0);
      expect(run).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        `${warning} Reason: PostgreSQL migration inputs changed.\n`
      );
      expect(
        JSON.parse(
          formatOutput(result, { json: true, summary: false, verbose: false })
        )
      ).toMatchObject({
        postgresImpactReasons: ['migration'],
        postgresTestFiles: [otherSpec, postgresTest],
        testFiles: [],
      });
    }
  );

  it.each([
    'drizzle/migrations/meta/0012_snapshot.json',
    'drizzle/migrations-not-used/0012_example.sql',
  ])(
    'does not treat unused metadata or similarly named paths as runtime migration input: %s',
    async (file) => {
      const result = await findAffectedTests({
        cwd: makeTempCwd([postgresTest]),
        changedFiles: [file],
      });
      expect(result.warnings).toEqual([]);
      expect(result.postgresTestFiles).toEqual([]);
    }
  );

  it('deduplicates normalized migration suite paths with direct and discovered specs', async () => {
    const cwd = makeTempCwd([postgresTest, unitTest, source]);
    const result = await findAffectedTests({
      cwd,
      changedFiles: [
        '.\\drizzle\\migrations\\0012_example.sql',
        'drizzle/migrations/meta/_journal.json',
        postgresTest,
        source,
      ],
      allTestFiles: [
        unitTest,
        `./${postgresTest}`,
        postgresTest.replaceAll('/', '\\'),
      ],
      dependencyCruiser: async () => report,
    });
    expect(result.postgresTestFiles).toEqual([postgresTest]);
    expect(result.postgresImpactReasons).toEqual([
      'direct_test',
      'migration',
      'dependency',
    ]);
    expect(result.warnings).toEqual([
      `${warning} Reason: a PostgreSQL spec changed; PostgreSQL migration inputs changed; changed code is used by PostgreSQL specs.`,
    ]);
    const run = vi.fn(async () => 0);
    await main(['--run'], {
      findAffectedTests: async () => result,
      runVitest: run,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });
    expect(run).toHaveBeenCalledExactlyOnceWith([unitTest]);
  });

  it('follows transitive setup dependencies without importing setup modules', async () => {
    const dependency = 'src/setup-dependency.ts';
    const intermediate = 'src/setup-bridge.ts';
    const setup = POSTGRES_SETUP_FILES[0];
    const otherSpec = 'tests/integration/another.postgres.integration.test.ts';
    const cwd = makeTempCwd([
      dependency,
      intermediate,
      setup,
      unitTest,
      postgresTest,
      otherSpec,
    ]);
    fs.writeFileSync(
      path.join(cwd, setup),
      'throw new Error("setup must not execute during discovery");'
    );
    const setupReport: DependencyCruiserReport = {
      modules: [
        { source: dependency },
        { source: intermediate, dependencies: [{ resolved: dependency }] },
        { source: setup, dependencies: [{ resolved: intermediate }] },
        { source: unitTest, dependencies: [{ resolved: dependency }] },
        { source: postgresTest },
        { source: otherSpec },
      ],
    };
    const result = await findAffectedTests({
      cwd,
      changedFiles: [dependency],
      dependencyCruiser: async () => setupReport,
    });
    expect(result.postgresTestFiles).toEqual([otherSpec, postgresTest]);
    expect(result.postgresImpactReasons).toEqual(['dependency']);
    expect(result.dependencyCruiserFailed).toBe(false);
    expect(result.testFiles).toEqual([unitTest]);
    expect(result.warnings).toEqual([
      `${warning} Reason: changed code is used by PostgreSQL specs.`,
    ]);
  });

  it('retains guidance for a deleted PostgreSQL spec without listing a nonexistent path', async () => {
    const removed = 'tests/integration/removed.postgres.integration.test.ts';
    const result = await findAffectedTests({
      cwd: makeTempCwd([unitTest]),
      changedFiles: [removed],
    });
    expect(result.postgresTestFiles).toEqual([]);
    expect(result.postgresImpactReasons).toEqual(['direct_test']);
    expect(result.warnings).toEqual([
      `${warning} Reason: a PostgreSQL spec changed.`,
    ]);
    expect(
      formatOutput(result, { json: false, summary: true, verbose: false })
    ).not.toContain('PostgreSQL spec paths:');
    expect(
      JSON.parse(
        formatOutput(result, { json: true, summary: false, verbose: false })
      )
    ).toMatchObject({
      postgresTestFiles: [],
      postgresImpactReasons: ['direct_test'],
    });
  });

  it('filters deleted graph specs while retaining existing affected specs', async () => {
    const removed = 'tests/integration/removed.postgres.integration.test.ts';
    const result = await findAffectedTests({
      cwd: makeTempCwd([source, postgresTest, unitTest]),
      changedFiles: [removed, source],
      dependencyCruiser: async () => ({
        modules: [
          ...report.modules,
          { source: removed, dependencies: [{ resolved: source }] },
        ],
      }),
    });
    expect(result.postgresTestFiles).toEqual([postgresTest]);
    expect(result.postgresImpactReasons).toEqual(['direct_test', 'dependency']);
  });

  it.each([
    {
      name: 'a direct spec',
      changes: [postgresTest],
      tests: [],
      reasons: ['direct_test'],
      detail: 'a PostgreSQL spec changed',
    },
    {
      name: 'a transitive source',
      changes: [source],
      tests: [unitTest],
      reasons: ['dependency'],
      detail: 'changed code is used by PostgreSQL specs',
    },
    {
      name: 'mixed config, spec, and source changes',
      changes: ['vitest.postgres.config.ts', postgresTest, source],
      tests: [unitTest],
      reasons: ['direct_test', 'configuration', 'dependency'],
      detail:
        'a PostgreSQL spec changed; PostgreSQL configuration changed; changed code is used by PostgreSQL specs',
    },
    {
      name: 'an ordinary config mixed with a related source',
      changes: ['vitest.config.ts', source],
      tests: [unitTest],
      reasons: ['dependency'],
      detail: 'changed code is used by PostgreSQL specs',
    },
  ])(
    'warns once for $name while selecting only ordinary tests',
    async ({ changes, tests, reasons, detail }) => {
      const cwd = makeTempCwd([source, unitTest, postgresTest]);
      const result = await findAffectedTests({
        changedFiles: changes,
        allTestFiles: [unitTest, postgresTest],
        cwd,
        dependencyCruiser: async () => report,
      });
      expect(result.testFiles).toEqual(tests);
      const expectedWarning = `${warning} Reason: ${detail}.`;
      expect(result.warnings).toEqual([expectedWarning]);
      expect(result.postgresTestFiles).toEqual([postgresTest]);
      expect(result.postgresImpactReasons).toEqual(reasons);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const dependencies = {
        findAffectedTests: async () => result,
        stdout: (message: string) => stdout.push(message),
        stderr: (message: string) => stderr.push(message),
      };
      expect(await main([], dependencies)).toBe(0);
      expect(stderr).toEqual([`${expectedWarning}\n`]);
      stdout.length = 0;
      stderr.length = 0;
      expect(await main(['--json'], dependencies)).toBe(0);
      expect(JSON.parse(stdout.join(''))).toMatchObject({
        warnings: [expectedWarning],
        postgresTestFiles: [postgresTest],
        postgresImpactReasons: reasons,
      });
      expect(stderr).toEqual([]);
    }
  );

  it('normalizes paths before matching direct specs and graph importers', async () => {
    const result = await findAffectedTests({
      changedFiles: [
        `./${postgresTest}`,
        postgresTest.replaceAll('/', '\\'),
        `./${source}`,
      ],
      cwd: makeTempCwd([source, postgresTest, unitTest]),
      dependencyCruiser: async () => report,
    });
    expect(result.warnings).toEqual([
      `${warning} Reason: a PostgreSQL spec changed; changed code is used by PostgreSQL specs.`,
    ]);
    expect(result.testFiles).toEqual([unitTest]);
    expect(result.postgresTestFiles).toEqual([postgresTest]);
    expect(result.postgresImpactReasons).toEqual(['direct_test', 'dependency']);
  });

  it('does not warn when changed sources have no PostgreSQL importers', async () => {
    const result = await findAffectedTests({
      changedFiles: [source],
      cwd: makeTempCwd([source, unitTest]),
      dependencyCruiser: async () => ({
        modules: report.modules.filter(
          (module) => module.source !== postgresTest
        ),
      }),
    });
    expect(result.warnings).toEqual([]);
  });

  it.each([
    'vitest.config.ts',
    'tests/setup.browser.ts',
    'tests/server/test-setup.ts',
    'tests/server/pglite-global-setup.ts',
  ])('does not warn for ordinary-only configuration %s', async (config) => {
    const result = await findAffectedTests({
      changedFiles: [config],
      allTestFiles: [unitTest],
    });
    expect(result.warnings).toEqual([]);
    expect(result.postgresImpactReasons).toEqual([]);
    expect(result.postgresTestFiles).toEqual([]);
    expect(result.runAll).toBe(true);
  });

  it.each([
    'vitest.postgres.config.ts',
    'tests/setup.base.ts',
    'tsconfig.json',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ])('warns for PostgreSQL configuration %s', async (config) => {
    const result = await findAffectedTests({
      changedFiles: [config],
      allTestFiles: [unitTest, postgresTest],
    });
    expect(result.warnings).toEqual([
      `${warning} Reason: PostgreSQL configuration changed.`,
    ]);
    expect(result.postgresImpactReasons).toEqual(['configuration']);
    expect(result.testFiles).not.toContain(postgresTest);
  });

  it.each([[source], ['vitest.config.ts', source]])(
    'warns conservatively when graph discovery fails for %j',
    async (...changes) => {
      const result = await findAffectedTests({
        changedFiles: changes,
        cwd: makeTempCwd([source, unitTest, postgresTest]),
        allTestFiles: [unitTest, postgresTest],
        dependencyCruiser: async () => {
          throw new Error('unavailable');
        },
      });
      expect(result.dependencyCruiserFailed).toBe(true);
      expect(result.postgresTestFiles).toEqual([]);
      expect(result.postgresImpactReasons).toEqual(['graph_unavailable']);
      expect(result.warnings).toEqual([
        'Warning: dependency-cruiser failed; dependency-based test discovery is unavailable.',
        `${warning} Reason: dependency analysis failed for source or support changes.`,
      ]);
      expect(result.testFiles).not.toContain(postgresTest);
      expect(result.excludedChangedFiles).toEqual([]);
    }
  );

  it('reports known PostgreSQL specs and reasons in summary and verbose output', async () => {
    const result = await findAffectedTests({
      changedFiles: [source],
      cwd: makeTempCwd([source, unitTest, postgresTest]),
      dependencyCruiser: async () => report,
    });
    const summary = formatOutput(result, {
      json: false,
      summary: true,
      verbose: false,
    });
    expect(summary).toContain(`PostgreSQL spec paths:\n  ${postgresTest}`);
    expect(summary).toContain(
      'PostgreSQL impact: changed code is used by PostgreSQL specs'
    );
    const verbose = formatOutput(result, {
      json: false,
      summary: false,
      verbose: true,
    });
    expect(verbose).toContain(
      `# PostgreSQL specs - dedicated command (1):\n#   ${postgresTest}`
    );
    expect(verbose).toContain(
      '# PostgreSQL impact reasons (1):\n#   changed code is used by PostgreSQL specs'
    );
  });
});

describe('mirror path strategy', () => {
  it('computes repo-specific unit, browser, and integration candidates', () => {
    const paths = computeMirrorTestPaths([
      'scripts/affected-tests.ts',
      'src/modules/design/domain/design.ts',
      'src/router.tsx',
      'src/routes/(auth)/actions.ts',
    ]);

    expect(paths).toContain('tests/unit/scripts/affected-tests.unit.spec.ts');
    expect(paths).toContain('tests/unit/__tests__/router.unit.spec.ts');
    expect(paths).toContain(
      'tests/unit/modules/design/domain/__tests__/design.unit.spec.ts'
    );
    expect(paths).toContain(
      'tests/browser/modules/design/domain/design.browser.spec.tsx'
    );
    expect(paths).toContain(
      'tests/integration/modules/design/domain/design.integration.test.ts'
    );
    expect(paths).toContain(
      'tests/integration/modules/design/domain/design.integration.spec.ts'
    );
    expect(paths).toContain('tests/unit/routes/(auth)/actions.unit.spec.ts');
    expect(paths).toContain('tests/unit/routes/auth/actions.unit.spec.ts');
    expect(paths.some((candidate) => candidate.includes('/./'))).toBe(false);
  });

  it('keeps only mirror candidates that exist', () => {
    const cwd = makeTempCwd(['tests/unit/scripts/affected-tests.unit.spec.ts']);

    expect(runStrategyB(['scripts/affected-tests.ts'], cwd)).toEqual([
      'tests/unit/scripts/affected-tests.unit.spec.ts',
    ]);
  });
});

describe('dependency graph strategy', () => {
  it('reports only intentional exclusions during a full-suite fallback with a successful graph', async () => {
    const source = 'src/a.ts';
    const missing = 'src/new.ts';
    const unit = 'tests/unit/a.unit.spec.ts';
    const result = await findAffectedTests({
      cwd: makeTempCwd([source, missing, unit]),
      changedFiles: ['vitest.config.ts', source, missing, 'README.md'],
      allTestFiles: [unit],
      dependencyCruiser: async () => ({
        modules: [
          { source },
          { source: unit, dependencies: [{ resolved: source }] },
        ],
      }),
    });
    expect(result.runAll).toBe(true);
    expect(result.excludedChangedFiles).toEqual(['README.md']);
    expect(result.strategyAFiles).toEqual([unit]);
    expect(result.strategyBFiles).toEqual([]);
    expect(result.testFiles).toEqual([unit]);
  });

  it('walks transitive importers until it reaches runnable tests', () => {
    const report: DependencyCruiserReport = {
      modules: [
        { source: 'src/modules/user/domain/user.ts' },
        {
          dependencies: [{ resolved: 'src/modules/user/domain/user.ts' }],
          source: 'src/modules/user/index.ts',
        },
        {
          dependencies: [{ resolved: 'src/modules/user/index.ts' }],
          source: 'tests/unit/modules/user/domain/user.unit.spec.ts',
        },
      ],
    };

    expect(
      findRelatedTestsInGraph(['src/modules/user/domain/user.ts'], report)
    ).toEqual({
      consideredSourceFiles: ['src/modules/user/domain/user.ts'],
      postgresTestFiles: [],
      testFiles: ['tests/unit/modules/user/domain/user.unit.spec.ts'],
    });
  });

  it('combines direct, graph, and mirror tests with excluded change details', async () => {
    const cwd = makeTempCwd([
      'src/modules/foo/foo.ts',
      'tests/unit/modules/foo/foo.unit.spec.ts',
      'tests/unit/modules/foo/foo-graph.unit.spec.ts',
      'tests/security/server-functions.unit.spec.ts',
    ]);
    const report: DependencyCruiserReport = {
      modules: [
        { source: 'src/modules/foo/foo.ts' },
        {
          dependencies: [{ resolved: 'src/modules/foo/foo.ts' }],
          source: 'tests/unit/modules/foo/foo-graph.unit.spec.ts',
        },
      ],
    };

    const result = await findAffectedTests({
      changedFiles: [
        'src/modules/foo/foo.ts',
        'tests/security/server-functions.unit.spec.ts',
        'README.md',
      ],
      cwd,
      dependencyCruiser: async () => report,
    });

    expect(result.directTestFiles).toEqual([
      'tests/security/server-functions.unit.spec.ts',
    ]);
    expect(result.strategyAFiles).toEqual([
      'tests/unit/modules/foo/foo-graph.unit.spec.ts',
    ]);
    expect(result.strategyBFiles).toEqual([
      'tests/unit/modules/foo/foo.unit.spec.ts',
    ]);
    expect(result.excludedChangedFiles).toEqual(['README.md']);
    expect(result.testFiles).toEqual([
      'tests/security/server-functions.unit.spec.ts',
      'tests/unit/modules/foo/foo-graph.unit.spec.ts',
      'tests/unit/modules/foo/foo.unit.spec.ts',
    ]);
  });

  it('runs all tests when dependency-cruiser fails for test support changes', async () => {
    const cwd = makeTempCwd([
      'tests/browser/components/form.browser.spec.tsx',
      'tests/server/test-utils.ts',
      'tests/unit/a.unit.spec.ts',
    ]);

    const result = await findAffectedTests({
      changedFiles: ['tests/server/test-utils.ts'],
      cwd,
      dependencyCruiser: async () => {
        throw new Error('dependency-cruiser failed');
      },
    });

    expect(result.dependencyCruiserFailed).toBe(true);
    expect(result.runAll).toBe(true);
    expect(result.runAllReason).toBe(
      'dependency-cruiser failed for test support changes'
    );
    expect(result.excludedChangedFiles).toEqual([]);
    expect(result.testFiles).toEqual([
      'tests/browser/components/form.browser.spec.tsx',
      'tests/unit/a.unit.spec.ts',
    ]);
    expect(result.warnings).toEqual([
      'Warning: dependency-cruiser failed; dependency-based test discovery is unavailable.',
      'PostgreSQL checks may be affected. Run pnpm test:integration:postgres to verify them. Reason: dependency analysis failed for source or support changes.',
    ]);
  });
});

describe('output formatting', () => {
  const result = makeResult({
    changedFiles: ['src/a.ts'],
    directTestFiles: ['tests/unit/a.unit.spec.ts'],
    excludedChangedFiles: ['README.md'],
    rootsCruised: ['src', 'tests'],
    strategyAFiles: ['tests/unit/a-graph.unit.spec.ts'],
    strategyBFiles: ['tests/unit/a.unit.spec.ts'],
    testFiles: ['tests/unit/a-graph.unit.spec.ts', 'tests/unit/a.unit.spec.ts'],
  });

  it('prints plain path output by default', () => {
    expect(
      formatOutput(result, { json: false, summary: false, verbose: false })
    ).toBe('tests/unit/a-graph.unit.spec.ts\ntests/unit/a.unit.spec.ts');
  });

  it('prints verbose discovery sections', () => {
    expect(
      formatOutput(result, { json: false, summary: false, verbose: true })
    ).toContain('# Strategy A - dependency-cruiser (1):');
  });

  it('prints summary output', () => {
    expect(
      formatOutput(result, { json: false, summary: true, verbose: false })
    ).toContain('Total affected tests: 2');
  });

  it('prints JSON output', () => {
    expect(
      JSON.parse(
        formatOutput(result, { json: true, summary: false, verbose: false })
      )
    ).toMatchObject({
      testFiles: [
        'tests/unit/a-graph.unit.spec.ts',
        'tests/unit/a.unit.spec.ts',
      ],
    });
  });
});

describe('Vitest runner command', () => {
  const ordinary = 'tests/unit/a.unit.spec.ts';
  it('executes one command and preserves its exit status', async () => {
    const execute = vi.fn(async () => 7);
    await expect(runVitest([ordinary], execute)).resolves.toBe(7);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      buildVitestCommand([ordinary])
    );
    execute.mockClear();
    await expect(runVitest([], execute)).resolves.toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('builds the expected pnpm Vitest command', () => {
    expect(buildVitestCommand(['tests/unit/a.unit.spec.ts'])).toEqual({
      args: [
        'exec',
        'vitest',
        'run',
        '--passWithNoTests',
        'tests/unit/a.unit.spec.ts',
      ],
      command: 'pnpm',
    });
  });

  it('does not spawn Vitest when the CLI run finds no affected tests', async () => {
    const stderr: string[] = [];
    const runVitest = vi.fn(async () => 1);
    const code = await main(['--run'], {
      findAffectedTests: async () => makeResult(),
      runVitest,
      stderr: (message) => stderr.push(message),
      stdout: vi.fn(),
    });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('No affected test files found.');
    expect(runVitest).not.toHaveBeenCalled();
  });

  it('returns Vitest exit codes from the CLI run path', async () => {
    const runVitest = vi.fn(async () => 7);
    const findAffectedTests = vi.fn(async () =>
      makeResult({ testFiles: ['tests/unit/a.unit.spec.ts'] })
    );
    const stdout: string[] = [];

    const code = await main(['--run', '--base', 'origin/main'], {
      findAffectedTests,
      runVitest,
      stderr: vi.fn(),
      stdout: (message) => stdout.push(message),
    });

    expect(code).toBe(7);
    expect(findAffectedTests).toHaveBeenCalledWith({ base: 'origin/main' });
    expect(runVitest).toHaveBeenCalledWith(['tests/unit/a.unit.spec.ts']);
    expect(stdout.join('')).toContain('tests/unit/a.unit.spec.ts');
  });
});

describe('sorting helpers', () => {
  it('normalizes, deduplicates, and sorts paths', () => {
    expect(deduplicateAndSort(['./b.ts', 'a.ts', 'b.ts', ''])).toEqual([
      'a.ts',
      'b.ts',
    ]);
    expect(normalizePath('./tests/unit/./__tests__/router.unit.spec.ts')).toBe(
      'tests/unit/__tests__/router.unit.spec.ts'
    );
  });
});

describe('CLI entrypoint detection', () => {
  it('compares Windows entrypoint paths case-insensitively', () => {
    expect(
      isCliEntrypoint(
        String.raw`c:\repo\scripts\affected-tests.ts`,
        String.raw`C:\repo\scripts\affected-tests.ts`,
        'win32'
      )
    ).toBe(true);
  });

  it('keeps non-Windows entrypoint checks case-sensitive', () => {
    expect(isCliEntrypoint('/repo/script.ts', '/repo/script.ts', 'linux')).toBe(
      true
    );
    expect(isCliEntrypoint('/repo/script.ts', '/Repo/script.ts', 'linux')).toBe(
      false
    );
  });
});
