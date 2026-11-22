import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolvePinnedTestPnpm } from '@tests/support/pinned-test-pnpm';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function executable(version: string) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pinned-pnpm-'));
  directories.push(directory);
  writeFileSync(
    path.join(directory, 'pnpm'),
    `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
    { mode: 0o700 }
  );
  return directory;
}
it('diagnoses a missing installed pnpm without falling back to npm_execpath', () => {
  expect(() =>
    resolvePinnedTestPnpm('pnpm@11.9.0', {
      PATH: '',
      npm_execpath: '/unrelated/pnpm.cjs',
    })
  ).toThrow('pnpm 11.9.0 was not found on PATH');
});
it('rejects the first mismatched candidate instead of switching to a later match', () => {
  const first = executable('1.0.0');
  const later = executable('11.9.0');
  expect(() =>
    resolvePinnedTestPnpm('pnpm@11.9.0', {
      PATH: [first, later].join(path.delimiter),
    })
  ).toThrow('found 1.0.0');
});
it('binds the exact installed executable independently of npm_execpath', () => {
  const directory = executable('11.9.0');
  expect(
    resolvePinnedTestPnpm('pnpm@11.9.0+integrity', {
      PATH: directory,
      npm_execpath: '/unrelated/npm.cjs',
    })
  ).toBe(path.join(directory, 'pnpm'));
});
