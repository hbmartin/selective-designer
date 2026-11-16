import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';
import { expect, it } from 'vitest';

import { verifyBackButtonCompiler } from '../../scripts/verify-back-button-compiler';

const entry = fileURLToPath(
  new URL('../../src/platform/components/back-button.tsx', import.meta.url)
);

const compileBackButton = ({
  transform,
  noEmit,
}: {
  transform?: (code: string) => string;
  noEmit?: boolean;
} = {}) => {
  const fixture: Plugin = {
    name: 'back-button-compiler-fixture',
    enforce: 'pre',
    transform(code, id) {
      if (id === entry && transform) return transform(code);
    },
  };
  return build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      fixture,
      react(),
      babel({ presets: [reactCompilerPreset({ noEmit })] }),
      verifyBackButtonCompiler(entry),
    ],
    build: {
      lib: {
        entry,
        formats: ['es'],
      },
      rolldownOptions: { external: (_id, importer) => importer !== undefined },
      minify: false,
      write: false,
    },
  });
};

it('compiles the default-valued props in BackButton with the production plugins', async () => {
  const result = await compileBackButton();
  const [output] = [result].flat();
  assert(output, 'Vite did not produce a build result');
  assert('output' in output, 'Vite returned a watcher instead of a bundle');
  const backButton = output.output.find((asset) => asset.type === 'chunk');
  assert(backButton, 'Vite did not emit an entry chunk');

  expect(backButton.exports).toContain('BackButton');
  expect(backButton.imports).toContain('react/compiler-runtime');
});

it('accepts a translation refactor that still compiles BackButton', async () => {
  await expect(
    compileBackButton({
      transform: (code) =>
        code.replace("useTranslation(['components'])", 'useTranslation()'),
    })
  ).resolves.toBeDefined();
});

it.each([
  {
    name: 'function opt-out',
    transform: (code: string) =>
      code.replace(
        '=> {\n  const { t }',
        "=> {\n  'use no memo';\n  const { t }"
      ),
  },
  {
    name: 'module opt-out',
    transform: (code: string) => `'use no memo';\n${code}`,
  },
  { name: 'noEmit', noEmit: true },
])(
  'rejects BackButton without emitted memoization ($name)',
  async (fixture) => {
    await expect(compileBackButton(fixture)).rejects.toThrow(
      'React Compiler did not emit a memo cache inside BackButton.'
    );
  }
);

it('fails separately when the rendered client export is absent', async () => {
  await expect(
    compileBackButton({ transform: () => 'export const other = 1;' })
  ).rejects.toThrow('BackButton was not rendered in a client chunk.');
});

it.each([
  {
    name: 'a shadowing parameter',
    body: 'export const BackButton = (cache) => cache(16);',
  },
  {
    name: 'a neighboring function',
    body: 'export const BackButton = () => null; export const Other = () => cache(16);',
  },
])('rejects a cache call from $name', async ({ body }) => {
  await expect(
    compileBackButton({
      transform: () =>
        `'use no memo'; import { c as cache } from 'react/compiler-runtime'; ${body}`,
    })
  ).rejects.toThrow(
    'React Compiler did not emit a memo cache inside BackButton.'
  );
});
