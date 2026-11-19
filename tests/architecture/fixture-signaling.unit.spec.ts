import fs from 'node:fs';
import path from 'node:path';
import { unsafeFixtureSignals } from '@tests/support/fixture-signal-policy';
import { expect, it } from 'vitest';

it.each([
  'process.kill(-pid, "SIGKILL")',
  'const original = process.kill; original(-pid)',
  'const { kill: signal } = process; signal(-pid)',
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
it('keeps executable fixture support and security sources inside the signal boundary', () => {
  const files: string[] = [];
  for (const folder of ['tests/support', 'tests/security']) {
    for (const name of fs.readdirSync(folder)) {
      if (/\.(?:ts|mjs|cjs)$/.test(name) && !/\.d\.[cm]?ts$/.test(name))
        files.push(path.join(folder, name));
    }
  }
  expect(
    files.flatMap((file) =>
      unsafeFixtureSignals(fs.readFileSync(file, 'utf8'), file).map(
        (problem) => `${file}: ${problem}`
      )
    )
  ).toEqual([]);
});
