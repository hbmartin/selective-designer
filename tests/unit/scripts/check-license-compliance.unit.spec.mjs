import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  findLicenseViolations,
  isLicenseAllowed,
  resolvePnpmCliPath,
} from '../../../scripts/check-license-compliance.mjs';

describe('license compliance checker', () => {
  it('rejects restricted licenses hidden in mixed SPDX expressions', () => {
    expect(isLicenseAllowed('GPL-2.0 AND (MIT OR Apache-2.0)')).toBe(false);
    expect(isLicenseAllowed('(MIT OR Apache-2.0) AND GPL-2.0')).toBe(false);
  });

  it('allows parenthesized SPDX expressions when every required branch is acceptable', () => {
    expect(isLicenseAllowed('MIT AND (Apache-2.0 OR BSD-3-Clause)')).toBe(true);
    expect(isLicenseAllowed('(GPL-2.0 OR MIT) AND Apache-2.0')).toBe(true);
  });

  it('fails closed for malformed SPDX expressions', () => {
    expect(isLicenseAllowed('MIT AND (Apache-2.0 OR BSD-3-Clause')).toBe(false);
    expect(isLicenseAllowed('MIT OR')).toBe(false);
  });

  it('requires license exceptions to match both package name and license', () => {
    expect(
      findLicenseViolations({
        'FSL-1.1-MIT': [
          { name: '@sentry/cli', versions: ['1.2.3'] },
          { name: '@sentry/cli-linux-x64', versions: ['1.2.3'] },
        ],
        'MPL-2.0': [{ name: 'lightningcss-darwin-arm64', versions: ['1.0.0'] }],
      })
    ).toEqual([]);

    expect(
      findLicenseViolations({
        'GPL-3.0-only': [
          {
            name: '@sentry/cli',
            license: 'GPL-3.0-only',
            versions: ['1.2.3'],
          },
        ],
      })
    ).toEqual([
      {
        license: 'GPL-3.0-only',
        name: '@sentry/cli',
        versions: '1.2.3',
      },
    ]);
  });

  it('uses the package license when matching exceptions and reporting violations', () => {
    expect(
      findLicenseViolations({
        UNKNOWN: [
          {
            name: '@sentry/cli',
            license: 'FSL-1.1-MIT',
            versions: ['1.2.3'],
          },
        ],
      })
    ).toEqual([]);

    expect(
      findLicenseViolations({
        UNKNOWN: [
          {
            name: '@sentry/cli',
            license: 'SSPL-1.0',
            versions: ['1.2.3'],
          },
        ],
      })
    ).toEqual([
      {
        license: 'SSPL-1.0',
        name: '@sentry/cli',
        versions: '1.2.3',
      },
    ]);
  });

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
});
