import {
  createWorkflowFixture,
  describeCommand,
  disposeWorkflowFixtures,
  fixtureEnvironment,
  pnpmFixtureEnvironment,
  runFixtureCommand,
  runFixtureShell,
  type WorkflowFixture,
} from '@tests/support/workflow-fixtures';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, assert, expect, it, vi } from 'vitest';

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  packageManager: string;
};
const version = /^pnpm@(\d+\.\d+\.\d+)/.exec(manifest.packageManager)?.[1];
assert(version);
const fixtures: WorkflowFixture[] = [];
function makeFixture() {
  const fixture = createWorkflowFixture();
  fixtures.push(fixture);
  return fixture;
}
afterEach(async () => {
  await disposeWorkflowFixtures(fixtures, () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
});
function manager(fixture: WorkflowFixture, directory: string, source: string) {
  const bin = path.join(fixture.support, directory);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'pnpm'), source, { mode: 0o700 });
  return bin;
}

it('preserves caller tool precedence and runs exactly the validated pnpm with the current Node', async () => {
  const fixture = makeFixture();
  const first = manager(
    fixture,
    "manager's bin",
    `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log(${JSON.stringify(version)}); else console.log(JSON.stringify({node: process.execPath, args: process.argv.slice(2)}));\n`
  );
  const later = manager(
    fixture,
    'old-node-bin',
    '#!/bin/sh\nprintf "wrong manager\\n"\n'
  );
  fs.writeFileSync(path.join(later, 'node'), '#!/bin/sh\nexit 91\n', {
    mode: 0o700,
  });
  const parent = {
    PATH: `:${first}::${later}:`,
    npm_execpath: '/irrelevant/npm-cli.js',
  };
  const env = await pnpmFixtureEnvironment(
    fixture,
    manifest.packageManager,
    parent
  );
  expect(env.PATH?.split(path.delimiter)).toEqual([fixture.bin, first, later]);
  const result = await runFixtureShell(
    `pnpm '--flag=two words' "quote'argument" '$(touch forbidden)'`,
    fixture,
    { env }
  );
  assert.strictEqual(result.status, 0, describeCommand(result));
  expect(JSON.parse(result.stdout)).toEqual({
    node: process.execPath,
    args: ['--flag=two words', "quote'argument", '$(touch forbidden)'],
  });
  expect(fs.existsSync(path.join(fixture.cwd, 'forbidden'))).toBe(false);
});

it('retains a selected symlink spelling for a multi-call manager', async () => {
  const fixture = makeFixture();
  const bin = path.join(fixture.support, 'symlink bin');
  fs.mkdirSync(bin);
  const target = path.join(fixture.support, 'other-name');
  fs.writeFileSync(
    target,
    `#!/bin/sh\ncase "$0" in */pnpm) printf '%s\\n' '${version}' ;; *) exit 77 ;; esac\n`,
    { mode: 0o700 }
  );
  fs.symlinkSync(target, path.join(bin, 'pnpm'));
  const env = await pnpmFixtureEnvironment(fixture, manifest.packageManager, {
    PATH: bin,
  });
  const result = await runFixtureShell('pnpm --version', fixture, { env });
  assert.strictEqual(result.status, 0, describeCommand(result));
  expect(result.stdout.trim()).toBe(version);
});

it.each([undefined, '', ':', '::'])(
  'does not find a working-directory manager through empty PATH %j',
  async (PATH) => {
    const fixture = makeFixture();
    fs.writeFileSync(
      path.join(fixture.cwd, 'pnpm'),
      `#!/bin/sh\nprintf '${version}'\n`,
      { mode: 0o700 }
    );
    const env = fixtureEnvironment(fixture, { PATH });
    expect(env.PATH).toBe(fixture.bin);
    await expect(
      pnpmFixtureEnvironment(fixture, manifest.packageManager, { PATH })
    ).rejects.toThrow('was not found on PATH');
  }
);

it('preserves only approved cache paths and overrides download controls', () => {
  const fixture = makeFixture();
  const env = fixtureEnvironment(fixture, {
    PATH: '/usr/bin',
    HOME: '/custom/home',
    COREPACK_HOME: '/cache/corepack',
    PNPM_HOME: '/cache/pnpm',
    XDG_CACHE_HOME: '/cache/xdg',
    XDG_DATA_HOME: '/data/xdg',
    NODE_OPTIONS: '--require=untrusted',
    npm_execpath: '/wrong/pnpm',
    TOKEN: 'secret',
    GIT_DIR: '/other/repo',
    COREPACK_ENABLE_NETWORK: '1',
    COREPACK_ENV_FILE: '/untrusted/env',
    COREPACK_ENABLE_AUTO_PIN: '1',
    COREPACK_DEFAULT_TO_LATEST: '1',
    pnpm_config_pm_on_fail: 'download',
    pnpm_config_verify_deps_before_run: 'true',
    PNPM_CONFIG_PM_ON_FAIL: 'download',
    npm_config_manage_package_manager_versions: 'true',
  });
  expect(env).toMatchObject({
    HOME: '/custom/home',
    COREPACK_HOME: '/cache/corepack',
    PNPM_HOME: '/cache/pnpm',
    XDG_CACHE_HOME: '/cache/xdg',
    XDG_DATA_HOME: '/data/xdg',
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENV_FILE: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_DEFAULT_TO_LATEST: '0',
    pnpm_config_pm_on_fail: 'error',
    pnpm_config_verify_deps_before_run: 'false',
    pnpm_config_manage_package_manager_versions: 'false',
    npm_config_manage_package_manager_versions: 'false',
  });
  for (const key of [
    'NODE_OPTIONS',
    'npm_execpath',
    'TOKEN',
    'GIT_DIR',
    'PNPM_CONFIG_PM_ON_FAIL',
  ])
    expect(env[key]).toBeUndefined();
});

it.each(['raw-switch', 'cached-corepack', 'uncached-corepack'])(
  'validates %s without an installer or workflow side effect',
  async (kind) => {
    const fixture = makeFixture();
    const marker = path.join(fixture.cwd, 'install-attempt');
    const bin = manager(
      fixture,
      'manager',
      `#!/usr/bin/env node\nconst fs = require('node:fs'); const kind = ${JSON.stringify(kind)};\nif (kind === 'raw-switch' && process.env.pnpm_config_pm_on_fail === 'error') {console.error('switch disabled'); process.exit(7);}\nif (kind === 'uncached-corepack' && process.env.COREPACK_ENABLE_NETWORK === '0') {console.error('cache missing, network disabled'); process.exit(8);}\nif (process.env.COREPACK_ENABLE_NETWORK !== '0' || process.env.pnpm_config_pm_on_fail !== 'error') fs.writeFileSync(${JSON.stringify(marker)}, 'install');\nconsole.log(${JSON.stringify(version)});\n`
    );
    const validation = pnpmFixtureEnvironment(
      fixture,
      manifest.packageManager,
      { PATH: bin }
    );
    if (kind === 'cached-corepack') {
      const env = await validation;
      const result = await runFixtureShell('pnpm --version', fixture, { env });
      expect(result.stdout.trim()).toBe(version);
    } else {
      await expect(validation).rejects.toThrow(
        /switch disabled|network disabled/
      );
      expect(fs.existsSync(path.join(fixture.bin, 'pnpm'))).toBe(false);
    }
    expect(fs.existsSync(marker)).toBe(false);
  }
);

it('rejects a failing manager with diagnostics before creating the workflow launcher', async () => {
  const fixture = makeFixture();
  const bin = manager(
    fixture,
    'failure',
    '#!/bin/sh\nprintf "validation exploded\\n" >&2\nexit 23\n'
  );
  await expect(
    pnpmFixtureEnvironment(fixture, manifest.packageManager, { PATH: bin })
  ).rejects.toThrow(/Exit: 23[\s\S]*validation exploded/);
  expect(fs.existsSync(path.join(fixture.bin, 'pnpm'))).toBe(false);
});

it('aborts validation before creating the workflow launcher', async () => {
  const fixture = makeFixture();
  const bin = manager(
    fixture,
    'aborted',
    '#!/usr/bin/env node\nthrow new Error("must not run");\n'
  );
  await expect(
    pnpmFixtureEnvironment(
      fixture,
      manifest.packageManager,
      { PATH: bin },
      AbortSignal.abort('validation cancelled')
    )
  ).rejects.toThrow(/pnpm version probe cancelled[\s\S]*validation cancelled/);
  expect(fs.existsSync(path.join(fixture.bin, 'pnpm'))).toBe(false);
});

it(
  'bounds a hung version probe and reports its timeout',
  { timeout: 15_000 },
  async () => {
    const fixture = makeFixture();
    const bin = manager(
      fixture,
      'hung',
      '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n'
    );
    await expect(
      pnpmFixtureEnvironment(fixture, manifest.packageManager, { PATH: bin })
    ).rejects.toThrow(/pnpm version probe timed out[\s\S]*timeout: true/);
    expect(fs.existsSync(path.join(fixture.bin, 'pnpm'))).toBe(false);
  }
);

it('does not create a missing cwd while constructing the environment or attempting a command', async () => {
  const fixture = makeFixture();
  const cwd = path.join(fixture.cwd, 'missing');
  const env = fixtureEnvironment(fixture);
  const result = await runFixtureCommand(
    process.execPath,
    ['--version'],
    fixture,
    { cwd, env }
  );
  expect(result.error).toMatchObject({ code: 'ENOENT' });
  expect(fs.existsSync(cwd)).toBe(false);
});

it.each(['node', 'pnpm'])(
  'rejects an early fixture-local %s collision before probing',
  async (tool) => {
    const fixture = makeFixture();
    const marker = path.join(fixture.support, 'executed');
    const bin = manager(
      fixture,
      'candidate',
      `#!/bin/sh\nprintf marker > '${marker}'\nprintf '${version}\\n'\n`
    );
    const localBin = path.join(fixture.cwd, 'nested/node_modules/.bin');
    fs.mkdirSync(localBin, { recursive: true });
    const collision = path.join(localBin, tool);
    fs.writeFileSync(collision, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    await expect(
      pnpmFixtureEnvironment(fixture, manifest.packageManager, { PATH: bin })
    ).rejects.toThrow(collision);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(collision, 'utf8')).toContain('exit 99');
  }
);

it(
  'uses actual pinned pnpm and current Node for nested package scripts and rejects later collisions',
  { timeout: 20_000 },
  async ({ signal }) => {
    const fixture = makeFixture();
    const metadata = path.resolve('node_modules/.modules.yaml');
    const before = fs.readFileSync(metadata);
    fs.writeFileSync(
      path.join(fixture.cwd, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: manifest.packageManager,
        scripts: { outer: 'pnpm run inner', inner: 'node -p process.execPath' },
      })
    );
    fs.writeFileSync(
      path.join(fixture.cwd, '.npmrc'),
      'verify-deps-before-run=false\n'
    );
    const env = await pnpmFixtureEnvironment(
      fixture,
      manifest.packageManager,
      process.env,
      signal
    );
    const result = await runFixtureShell('pnpm run outer', fixture, {
      env,
      signal,
    });
    assert.strictEqual(result.status, 0, describeCommand(result));
    expect(result.stdout).toContain(process.execPath);
    for (const tool of ['node', 'pnpm']) {
      const localBin = path.join(fixture.cwd, 'node_modules/.bin');
      fs.mkdirSync(localBin, { recursive: true });
      const collision = path.join(localBin, tool);
      fs.writeFileSync(collision, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
      expect(() =>
        runFixtureShell('pnpm run outer', fixture, { env, signal })
      ).toThrow(collision);
      fs.unlinkSync(collision);
    }
    expect(fs.readFileSync(metadata)).toEqual(before);
  }
);

it('does not follow linked dependency directories while checking local tools', async () => {
  const fixture = makeFixture();
  const dependency = makeFixture();
  fs.mkdirSync(path.join(dependency.cwd, 'node_modules/.bin'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dependency.cwd, 'node_modules/.bin/node'),
    'not fixture-owned'
  );
  fs.mkdirSync(path.join(fixture.cwd, 'node_modules'));
  fs.symlinkSync(
    dependency.cwd,
    path.join(fixture.cwd, 'node_modules/dependency'),
    'dir'
  );
  const bin = manager(
    fixture,
    'candidate',
    `#!/bin/sh\nprintf '${version}\\n'\n`
  );
  await expect(
    pnpmFixtureEnvironment(fixture, manifest.packageManager, { PATH: bin })
  ).resolves.toBeDefined();
});

it('distinguishes an executable with a missing interpreter from a version mismatch', async () => {
  const fixture = makeFixture();
  const bin = manager(
    fixture,
    'unspawnable',
    '#!/missing/fixture-interpreter\n'
  );
  await expect(
    pnpmFixtureEnvironment(fixture, manifest.packageManager, { PATH: bin })
  ).rejects.toThrow(
    /pnpm version probe failed to spawn[\s\S]*Phase: version validation[\s\S]*ENOENT/
  );
});

it.each(['node_modules', 'node_modules/.bin'])(
  'rejects a linked tool container at %s without traversing it',
  async (relative) => {
    const fixture = makeFixture();
    const target = makeFixture();
    fs.writeFileSync(path.join(target.cwd, 'node'), '#!/bin/sh\nexit 99\n', {
      mode: 0o700,
    });
    const link = path.join(fixture.cwd, relative);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target.cwd, link, 'dir');
    const bin = manager(
      fixture,
      'candidate',
      `#!/bin/sh\nprintf '${version}\\n'\n`
    );
    await expect(
      pnpmFixtureEnvironment(fixture, manifest.packageManager, { PATH: bin })
    ).rejects.toThrow(link);
  }
);

it.each(['raw', 'shell'] as const)(
  'checks late collisions at the shared %s boundary including support',
  (kind) => {
    const fixture = makeFixture();
    const env = fixtureEnvironment(fixture);
    const bin = path.join(fixture.support, 'nested/node_modules/.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), 'must not execute');
    expect(() =>
      kind === 'raw'
        ? runFixtureCommand(process.execPath, ['--version'], fixture, { env })
        : runFixtureShell('node --version', fixture, { env })
    ).toThrow('Conflicting fixture-local tool');
  }
);

it.each(['Node', 'PNPM', 'NODE_MODULES/.bin/node', 'node_modules/.BIN/node'])(
  'uses canonical filesystem lookups for case variant %s',
  async (name) => {
    const fixture = makeFixture();
    const relative = name.includes('/') ? name : `node_modules/.bin/${name}`;
    const file = path.join(fixture.cwd, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'must not execute');
    const canonical = path.join(fixture.cwd, relative.toLowerCase());
    if (fs.existsSync(canonical)) {
      expect(() =>
        runFixtureCommand(process.execPath, ['--version'], fixture)
      ).toThrow('Conflicting fixture-local tool');
    } else {
      const result = await runFixtureCommand(
        process.execPath,
        ['--version'],
        fixture
      );
      assert.strictEqual(result.status, 0, describeCommand(result));
    }
  }
);

it('allows owned root/support cwd and rejects external and symlink escapes without creating paths', async () => {
  const fixture = makeFixture();
  const external = makeFixture();
  for (const cwd of [fixture.root, fixture.support]) {
    const result = await runFixtureCommand(
      process.execPath,
      ['-p', 'process.cwd()'],
      fixture,
      { cwd }
    );
    assert.strictEqual(result.status, 0, describeCommand(result));
    expect(result.stdout.trim()).toBe(cwd);
  }
  expect(() =>
    runFixtureCommand(process.execPath, [], fixture, { cwd: external.cwd })
  ).toThrow('must be owned');
  const link = path.join(fixture.support, 'escape');
  fs.symlinkSync(external.cwd, link, 'dir');
  expect(() =>
    runFixtureCommand(process.execPath, [], fixture, {
      cwd: path.join(link, 'missing'),
    })
  ).toThrow('symlink');
  expect(fs.existsSync(path.join(external.cwd, 'missing'))).toBe(false);
});
