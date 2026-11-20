import cases from './fixture-signaling-cases.json';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unsafeFixtureSignals } from '@tests/support/fixture-signal-policy';
import { expect, it } from 'vitest';

it.each([
  'process.kill(-pid, "SIGKILL")',
  'const { ["kill"]: signal } = process; signal(-pid)',
  'const { [`kill`]: signal } = process; signal(-pid)',
  'let signal; ({ kill: signal } = process); signal(-pid)',
  'let signal; ({ ["kill"]: signal } = process); signal(-pid)',
  'function execute({ kill: signal } = process) { signal(-pid) }',
  'function execute({ ["kill"]: signal } = process) { signal(-pid) }',
  'const execute = ({ kill: signal } = process) => signal(-pid)',
  'process[`kill`](-pid)',
  'vi.spyOn(process, `kill`)',

  'const original = process.kill; original(-pid)',
  'const { kill: signal } = process; signal(-pid)',
  'const { "kill": signal } = process; signal(-pid)',
  "const { 'kill': signal } = process; signal(-pid)",
  'const { kill } = process; kill(-pid)',
  'const original = process["kill"]; original(-pid)',
  'import { kill as signal } from "node:process"; signal(-pid)',
  'import runtime from "node:process"; runtime.kill(-pid)',
  'vi.spyOn(process, "kill")',
  'vi.spyOn(process, "kill").mockImplementationOnce(() => true)',
])('rejects unsafe syntax without running it: %s', (source) => {
  expect(
    unsafeFixtureSignals(source, 'tests/security/fixture-example.unit.spec.ts')
  ).not.toEqual([]);
});
it.each([
  'vi.spyOn(process, "kill").mockImplementation(() => true)',
  'vi.spyOn(process, "kill").mockReturnValue(true)',
  'vi.spyOn(process, `kill`).mockImplementation(() => true)',
  'const { ["kill"]: signal } = other; signal(-pid)',
  'function execute({ title } = process) {}',

  'import { signalFixtureGroup } from "./fixture-process-groups"; signalFixtureGroup(group, "SIGTERM", rows)',
])('accepts fully replaced spies and centralized operations: %s', (source) => {
  expect(
    unsafeFixtureSignals(source, 'tests/security/fixture-example.unit.spec.ts')
  ).toEqual([]);
});
it('permits raw signaling only inside the verified implementation', () => {
  expect(
    unsafeFixtureSignals(
      'process.kill(-group.pid, signal)',
      'tests/support/fixture-process-groups.ts'
    )
  ).toEqual([]);
});
const executableExtensions = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);
function fixtureSignalSources(folders: string[]) {
  const files: string[] = [];
  const visit = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (
        entry.isFile() &&
        executableExtensions.has(path.extname(file)) &&
        !/\.d\.[cm]?ts$/.test(file)
      )
        files.push(file);
    }
  };
  for (const folder of folders) visit(folder);
  return files.sort();
}
it('discovers nested executable sources without declarations or symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-signaling-'));
  try {
    const nested = path.join(root, 'nested', 'helpers');
    fs.mkdirSync(nested, { recursive: true });
    const expected = [...executableExtensions]
      .map((extension) => path.join(nested, `helper${extension}`))
      .sort();
    for (const file of expected)
      fs.writeFileSync(file, 'const { "kill": signal } = process;');
    for (const extension of ['.d.ts', '.d.mts', '.d.cts', '.json'])
      fs.writeFileSync(path.join(root, `excluded${extension}`), '');
    fs.symlinkSync(nested, path.join(root, 'directory-link'));
    fs.symlinkSync(expected[0]!, path.join(root, 'file-link.ts'));
    const files = fixtureSignalSources([root]);
    expect(files).toEqual(expected);
    expect(
      files.map(
        (file) =>
          unsafeFixtureSignals(fs.readFileSync(file, 'utf8'), file).length
      )
    ).toEqual(expected.map(() => 1));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('keeps executable fixture support and security sources inside the signal boundary', () => {
  const files = fixtureSignalSources(['tests/support', 'tests/security']);
  expect(
    files.flatMap((file) =>
      unsafeFixtureSignals(fs.readFileSync(file, 'utf8'), file).map(
        (problem) => `${file}: ${problem}`
      )
    )
  ).toEqual([]);
});

it.each(cases)(
  'checks the shared Semgrep corpus without executing it: $source',
  ({ source, rules }) => {
    expect(
      unsafeFixtureSignals(source, 'tests/security/case.js').length > 0
    ).toBe(rules.length > 0);
  }
);
