import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pnpmCommand, resolvePnpmCliPath } from '../../../scripts/lib/pnpm.mjs';

describe('package-manager command resolution', () => {
  it('resolves pnpm from an absolute package-manager runner path', () => {
    const pnpmPath = path.join(
      process.cwd(),
      'node_modules',
      '.bin',
      'pnpm.cjs'
    );

    expect(resolvePnpmCliPath({ npm_execpath: pnpmPath })).toBe(pnpmPath);
    expect(() => resolvePnpmCliPath({})).toThrow('Unable to locate pnpm CLI');
    expect(() => resolvePnpmCliPath({ npm_execpath: 'pnpm' })).toThrow(
      'non-absolute'
    );
    expect(() =>
      resolvePnpmCliPath({
        npm_execpath: path.join(
          process.cwd(),
          'node_modules',
          '.bin',
          'npm.cjs'
        ),
      })
    ).toThrow('pnpm');
  });

  it('runs JS pnpm entry points with node and standalone pnpm directly', () => {
    expect(
      pnpmCommand('/opt/pnpm/bin/pnpm.cjs', ['licenses'], '/usr/bin/node')
    ).toEqual({
      file: '/usr/bin/node',
      args: ['/opt/pnpm/bin/pnpm.cjs', 'licenses'],
    });
    expect(
      pnpmCommand('/opt/@pnpm/exe/pnpm', ['licenses'], '/usr/bin/node')
    ).toEqual({ file: '/opt/@pnpm/exe/pnpm', args: ['licenses'] });
  });
});
