import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const scanner = fileURLToPath(
  new URL('../../scripts/check-production-react-compiler.mjs', import.meta.url)
);
const runtimeImport = `
  import { t as createRuntime } from './compiler-runtime-fixture.js';
  let unrelated = {}, runtime = createRuntime();
`;
const backButtonLabel = 'components:backButton.label';

function scanAssets(source: string) {
  const assets = mkdtempSync(join(tmpdir(), 'react-compiler-assets-'));
  try {
    writeFileSync(join(assets, 'entry.js'), runtimeImport + source);
    writeFileSync(
      join(assets, 'compiler-runtime-fixture.js'),
      'export const t = () => ({ c: (size) => new Array(size) });'
    );
    return spawnSync(process.execPath, [scanner, assets], { encoding: 'utf8' });
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
}

it('accepts a minified compiler cache allocation without a memo sentinel', () => {
  const result = scanAssets(`
    const BackButton = () => {
      const cache = (0, runtime.c)(15);
      return cache[0] ?? translate(\`${backButtonLabel}\`);
    };
  `);

  expect(result).toMatchObject({ status: 0, stderr: '' });
});

it('scans a deeply nested minified sequence', () => {
  const result = scanAssets(`
    function BackButton() {
      const cache = runtime.c(15);
      return ${'step(), '.repeat(3_000)} translate('${backButtonLabel}');
    }
  `);

  expect(result).toMatchObject({ status: 0, stderr: '' });
});

it('reports a missing BackButton separately', () => {
  const result = scanAssets(`
    const Other = () => runtime.c(15);
    const translationKey = '${backButtonLabel}';
  `);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('BackButton was not found');
});

it('rejects memoization elsewhere in the same chunk', () => {
  const result = scanAssets(`
    function Parent() {
      const parentCache = runtime.c(15);
      function BackButton() {
        function Child() {
          return runtime.c(15);
        }
        unrelated.c(15);
        return translate('${backButtonLabel}');
      }
      function Sibling() {
        return runtime.c(15);
      }
      return BackButton;
    }
  `);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    'BackButton is missing the React Compiler memo cache'
  );
});
