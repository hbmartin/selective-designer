import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Vercel release command', () => {
  let directory: string;
  let stagesFile: string;
  let environmentFile: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'selective-designer-release-'));
    stagesFile = join(directory, 'stages');
    environmentFile = join(directory, 'environment');
    writeFileSync(stagesFile, '');
    writeFileSync(environmentFile, '');
    writeFileSync(
      join(directory, 'pnpm.cjs'),
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const stage = process.argv[2];
appendFileSync(process.env.TEST_RELEASE_STAGES, stage + '\\n');
appendFileSync(process.env.TEST_RELEASE_ENVIRONMENT, JSON.stringify({ stage, baseUrl: process.env.VITE_BASE_URL ?? null }) + '\\n');
if (process.env.NODE_ENV !== 'production') process.exit(9);
process.exit(Number(stage === 'build' ? process.env.TEST_BUILD_STATUS : stage === 'db:validate-migration-config' ? (process.env.TEST_PREFLIGHT_STATUS ?? '0') : process.env.TEST_MIGRATION_STATUS));
`,
      { mode: 0o755 }
    );
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function runRelease(
    environment?: string,
    buildStatus = 0,
    migrationStatus = 0,
    variables: NodeJS.ProcessEnv = {}
  ) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      npm_execpath: join(directory, 'pnpm.cjs'),
      TEST_RELEASE_STAGES: stagesFile,
      TEST_RELEASE_ENVIRONMENT: environmentFile,
      TEST_BUILD_STATUS: String(buildStatus),
      TEST_MIGRATION_STATUS: String(migrationStatus),
    };
    delete env.VERCEL_TARGET_ENV;
    delete env.VERCEL_ENV;
    delete env.VITE_BASE_URL;
    delete env.VERCEL_BRANCH_URL;
    delete env.VERCEL_URL;
    if (environment !== undefined) env.VERCEL_ENV = environment;
    Object.assign(env, variables);

    const result = spawnSync(
      process.execPath,
      [resolve('scripts/build-vercel.mjs')],
      { env, encoding: 'utf8' }
    );
    return {
      ...result,
      stages: readFileSync(stagesFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean),
      environments: readFileSync(environmentFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { stage: string; baseUrl: string | null }
        ),
    };
  }

  it('builds and then migrates production before reporting success', () => {
    const result = runRelease('production');
    expect(result.status).toBe(0);
    expect(result.stages).toEqual([
      'db:validate-migration-config',
      'build',
      'db:migrate',
    ]);
  });

  it.each(['preview'])('only builds outside production (%s)', (environment) => {
    const result = runRelease(environment);
    expect(result.status).toBe(0);
    expect(result.stages).toEqual(['build']);
  });

  it('blocks the release and skips migrations when compilation fails', () => {
    const result = runRelease('production', 4);
    expect(result.status).toBe(4);
    expect(result.stages).toEqual(['db:validate-migration-config', 'build']);
    expect(result.stderr).toContain('Release stage failed: build');
  });

  it('blocks the release when migration fails', () => {
    const result = runRelease('production', 0, 5);
    expect(result.status).toBe(5);
    expect(result.stages).toEqual([
      'db:validate-migration-config',
      'build',
      'db:migrate',
    ]);
    expect(result.stderr).toContain('Release stage failed: db:migrate');
  });

  it('wires Vercel to the release command', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(config.buildCommand).toBe('pnpm build:vercel');
    expect(manifest.scripts['build:vercel']).toBe(
      'node scripts/build-vercel.mjs'
    );
  });

  it('derives the preview branch URL without framework-prefixed variables', () => {
    const result = runRelease('preview', 0, 0, {
      VERCEL_BRANCH_URL: 'project-git-feature-team.vercel.app',
      VERCEL_URL: 'project-deployment-team.vercel.app',
    });
    expect(result.status).toBe(0);
    expect(result.environments).toEqual([
      {
        stage: 'build',
        baseUrl: 'https://project-git-feature-team.vercel.app',
      },
    ]);
    expect(result.stages).toEqual(['build']);
  });

  it.each([undefined, '   '])(
    'falls back to the deployment URL with branch URL %s',
    (branchUrl) => {
      const result = runRelease('preview', 0, 0, {
        VERCEL_BRANCH_URL: branchUrl,
        VERCEL_URL: 'project-deployment-team.vercel.app',
      });
      expect(result.environments).toEqual([
        {
          stage: 'build',
          baseUrl: 'https://project-deployment-team.vercel.app',
        },
      ]);
    }
  );

  it('preserves an explicit preview URL', () => {
    const result = runRelease('preview', 0, 0, {
      VITE_BASE_URL: 'https://preview.example.com',
      VERCEL_BRANCH_URL: 'project-git-feature-team.vercel.app',
    });
    expect(result.environments).toEqual([
      { stage: 'build', baseUrl: 'https://preview.example.com' },
    ]);
  });

  it('derives a URL when the explicit preview setting is blank', () => {
    const result = runRelease('preview', 0, 0, {
      VITE_BASE_URL: '   ',
      VERCEL_BRANCH_URL: 'project-git-feature-team.vercel.app',
    });
    expect(result.environments[0]?.baseUrl).toBe(
      'https://project-git-feature-team.vercel.app'
    );
  });

  it('preserves the production URL for the build and migrations', () => {
    const result = runRelease('production', 0, 0, {
      VITE_BASE_URL: 'https://app.example.com',
      VERCEL_BRANCH_URL: 'project-git-main-team.vercel.app',
    });
    expect(result.environments).toEqual([
      {
        stage: 'db:validate-migration-config',
        baseUrl: 'https://app.example.com',
      },
      { stage: 'build', baseUrl: 'https://app.example.com' },
      { stage: 'db:migrate', baseUrl: 'https://app.example.com' },
    ]);
  });

  it.each(['production', 'development', undefined])(
    'does not infer a URL outside preview (%s)',
    (environment) => {
      const result = runRelease(environment, 0, 0, {
        VERCEL_BRANCH_URL: 'project-git-main-team.vercel.app',
        VERCEL_URL: 'project-deployment-team.vercel.app',
      });
      expect(result.environments.every((entry) => entry.baseUrl === null)).toBe(
        true
      );
    }
  );

  it('leaves a missing preview URL for existing application validation', () => {
    const result = runRelease('preview');
    expect(result.environments).toEqual([{ stage: 'build', baseUrl: null }]);
  });
  it.each([undefined, '', 'development', 'staging'])(
    'rejects unsupported target %s before building',
    (target) => {
      const result = runRelease(target);
      expect(result.status).toBe(1);
      expect(result.stages).toEqual([]);
      expect(result.stderr).toContain('requires VERCEL_ENV');
    }
  );
  it.each(['production', 'preview'])(
    'accepts a matching explicit target %s',
    (target) => {
      expect(
        runRelease(target, 0, 0, { VERCEL_TARGET_ENV: target }).status
      ).toBe(0);
    }
  );
  it.each([
    ['production', 'preview'],
    ['preview', 'production'],
    ['preview', 'staging'],
    ['preview', ''],
  ])('rejects contradictory/custom targets %s/%s', (environment, target) => {
    const result = runRelease(environment, 0, 0, { VERCEL_TARGET_ENV: target });
    expect(result.status).toBe(1);
    expect(result.stages).toEqual([]);
    expect(result.stderr).toContain('VERCEL_TARGET_ENV must match');
  });
  it('blocks production before compilation when migration configuration fails', () => {
    const result = runRelease('production', 0, 0, {
      TEST_PREFLIGHT_STATUS: '7',
    });
    expect(result.status).toBe(7);
    expect(result.stages).toEqual(['db:validate-migration-config']);
  });
  it('explains the Preview migration policy', () => {
    expect(runRelease('preview').stdout).toContain('migrations are disabled');
  });
  it('reports package-manager resolution failures without license-specific instructions', () => {
    const result = runRelease('production', 0, 0, { npm_execpath: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unable to locate pnpm CLI');
    expect(result.stderr).not.toContain('security:licenses');
  });
  it('reports the underlying launch failure', () => {
    const result = runRelease('preview', 0, 0, {
      npm_execpath: join(directory, 'missing-pnpm'),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).toContain('Release stage failed: build');
  });
  it('keeps migration preflight outside ordinary env validation', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    expect(scripts['db:validate-migration-config']).toContain(
      'validate-migration-config.ts'
    );
    expect(
      Object.keys(scripts).filter((name) => name.startsWith('env:'))
    ).not.toContain('env:migration');
  });
});
