import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Vercel release command', () => {
  let directory: string;
  let stagesFile: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'selective-designer-release-'));
    stagesFile = join(directory, 'stages');
    writeFileSync(stagesFile, '');
    writeFileSync(
      join(directory, 'pnpm.cjs'),
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const stage = process.argv[2];
appendFileSync(process.env.TEST_RELEASE_STAGES, stage + '\\n');
if (process.env.NODE_ENV !== 'production') process.exit(9);
process.exit(Number(stage === 'build' ? process.env.TEST_BUILD_STATUS : process.env.TEST_MIGRATION_STATUS));
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
    migrationStatus = 0
  ) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      npm_execpath: join(directory, 'pnpm.cjs'),
      TEST_RELEASE_STAGES: stagesFile,
      TEST_BUILD_STATUS: String(buildStatus),
      TEST_MIGRATION_STATUS: String(migrationStatus),
    };
    delete env.VERCEL_ENV;
    if (environment !== undefined) env.VERCEL_ENV = environment;

    const result = spawnSync(
      process.execPath,
      [resolve('scripts/build-vercel.mjs')],
      { env, encoding: 'utf8' }
    );
    return {
      ...result,
      stages: readFileSync(stagesFile, 'utf8').trim().split('\n'),
    };
  }

  it('builds and then migrates production before reporting success', () => {
    const result = runRelease('production');
    expect(result.status).toBe(0);
    expect(result.stages).toEqual(['build', 'db:migrate']);
  });

  it.each([undefined, 'preview', 'development'])(
    'only builds outside production (%s)',
    (environment) => {
      const result = runRelease(environment);
      expect(result.status).toBe(0);
      expect(result.stages).toEqual(['build']);
    }
  );

  it('blocks the release and skips migrations when compilation fails', () => {
    const result = runRelease('production', 4);
    expect(result.status).toBe(4);
    expect(result.stages).toEqual(['build']);
    expect(result.stderr).toContain('Release stage failed: build');
  });

  it('blocks the release when migration fails', () => {
    const result = runRelease('production', 0, 5);
    expect(result.status).toBe(5);
    expect(result.stages).toEqual(['build', 'db:migrate']);
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
});
