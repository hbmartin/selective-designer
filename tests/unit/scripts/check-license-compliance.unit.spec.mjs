import { describe, expect, it } from 'vitest';

import {
  findLicenseViolations,
  isLicenseAllowed,
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

  it('accepts LGPL analyzer configurations by exact package name and license', () => {
    const name = '@sonarsource/analyzer-commons-configurations';
    const similarName = `${name}-other`;
    const unrelatedName = 'another-lgpl-package';
    expect(
      findLicenseViolations({
        'LGPL-3.0-only': [
          { name },
          { name: similarName },
          { name: unrelatedName },
        ],
        'GPL-3.0-only': [{ name }],
      })
    ).toEqual([
      { name: similarName, license: 'LGPL-3.0-only', versions: '' },
      { name: unrelatedName, license: 'LGPL-3.0-only', versions: '' },
      { name, license: 'GPL-3.0-only', versions: '' },
    ]);
  });
});
