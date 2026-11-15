import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { expect, it } from 'vitest';

it('compiles the default-valued props in BackButton with the production plugins', async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
    build: {
      lib: {
        entry: fileURLToPath(
          new URL(
            '../../src/platform/components/back-button.tsx',
            import.meta.url
          )
        ),
        formats: ['es'],
      },
      rolldownOptions: { external: (_id, importer) => importer !== undefined },
      minify: false,
      write: false,
    },
  });

  const [output] = [result].flat();
  assert(output, 'Vite did not produce a build result');
  assert('output' in output, 'Vite returned a watcher instead of a bundle');
  const backButton = output.output.find((asset) => asset.type === 'chunk');
  assert(backButton, 'Vite did not emit an entry chunk');

  expect(backButton.exports).toContain('BackButton');
  expect(backButton.imports).toContain('react/compiler-runtime');
});
