import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build, normalizePath, type Plugin } from 'vite';
import { expect, it } from 'vitest';

import {
  backButtonUsesCompilerCache,
  verifyBackButtonCompiler,
} from '../../scripts/verify-back-button-compiler';

const entry = fileURLToPath(
  new URL('../../src/platform/components/back-button.tsx', import.meta.url)
);

function replaceFixture(code: string, before: string, after: string) {
  assert(code.includes(before), `Missing BackButton fixture text: ${before}`);
  return code.replace(before, after);
}

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
      if (normalizePath(id) === normalizePath(entry) && transform)
        return transform(code);
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
        replaceFixture(
          code,
          "useTranslation(['components'])",
          'useTranslation()'
        ),
    })
  ).resolves.toBeDefined();
});

it.each(['memo', 'forwardRef'])(
  'accepts a compiled BackButton wrapped in %s',
  async (wrapper) => {
    await expect(
      compileBackButton({
        transform: () => `import { ${wrapper} } from 'react';
        export const BackButton = ${wrapper}(function BackButton({ to = '..' }) {
          return <a href={to}>{to}</a>;
        });`,
      })
    ).resolves.toBeDefined();
  }
);

it.each([
  {
    name: 'function opt-out',
    transform: (code: string) =>
      replaceFixture(
        code,
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

const cacheImport = "import { c as cache } from 'react/compiler-runtime';";

it('distinguishes an unrelated transform from the BackButton transform', async () => {
  const verifier = verifyBackButtonCompiler(entry);
  const transform = verifier.transform;
  assert(transform && typeof transform === 'object');
  const handler = transform.handler.bind(
    {} as ThisParameterType<typeof transform.handler>
  );
  const unrelated = `${entry}?unrelated`;
  const compiled = `${cacheImport} export const BackButton = () => cache(16);`;

  const generate = verifier.generateBundle;
  assert(typeof generate === 'function');
  const context = {
    error: (message: unknown) => {
      throw new Error(String(message));
    },
    info: () => {},
  };
  const bundle = {
    'entry.js': {
      type: 'chunk',
      modules: { [normalizePath(entry)]: { renderedExports: ['BackButton'] } },
    },
  };
  const generateClientBundle = () =>
    Reflect.apply(generate, context, [{}, bundle, false]);
  const unrelatedCode = 'export const BackButton = () => null;';

  // Simulate a host calling the handler directly without applying its filter.
  await expect(handler(unrelatedCode, unrelated)).resolves.toBeUndefined();
  expect(generateClientBundle).toThrow(
    'The React Compiler verifier did not receive the BackButton transform.'
  );
  await handler(compiled, entry);
  await expect(handler(unrelatedCode, unrelated)).resolves.toBeUndefined();
  expect(generateClientBundle).not.toThrow();
});

it('preserves the ES2024 browser RegExp type when the verifier is present', async () => {
  const { default: ts } = await import('typescript');
  const verifier = fileURLToPath(
    new URL('../../scripts/verify-back-button-compiler.ts', import.meta.url)
  );
  const browserCaller = normalizePath(verifier).replace(
    'verify-back-button-compiler.ts',
    'synthetic-browser-caller.ts'
  );
  const options = {
    target: ts.ScriptTarget.ES2024,
    lib: ['lib.es2024.d.ts'],
    types: [],
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...args) =>
    normalizePath(file) === browserCaller
      ? ts.createSourceFile(file, 'RegExp.escape("a.b");', options.target)
      : getSourceFile(file, ...args);
  // Keep external declarations out of the fixture while resolving lib directives.
  host.resolveModuleNames = (names) => names.map(() => undefined);
  const program = ts.createProgram([verifier, browserCaller], options, host);
  const caller = program.getSourceFile(browserCaller);
  assert(caller);
  expect(program.getSemanticDiagnostics(caller)).toEqual([
    expect.objectContaining({
      code: 2550,
      messageText: expect.stringContaining("'escape'"),
    }),
  ]);
});

it.each([
  'export function BackButton() { return cache(16); }',
  'export const BackButton = () => cache(16);',
  'const BackButton = () => cache(16); export { BackButton };',
  'const Button = function () { return cache(16); }; export { Button as BackButton };',
  "import { memo as wrap } from 'react'; const Button = () => cache(16); export const BackButton = wrap(Button);",
  "import React from 'react'; const Button = React.forwardRef(() => cache(16)); export const BackButton = React.memo(Button);",
  "import * as React from 'react'; export const BackButton = React.memo(() => cache(16));",
])(
  'recognizes the local exported implementation in %s',
  async (declaration) => {
    await expect(
      backButtonUsesCompilerCache(entry, `${cacheImport} ${declaration}`)
    ).resolves.toBe(true);
  }
);

it.each([
  {
    name: 'a shadowing parameter',
    body: 'export const BackButton = (cache) => cache(16);',
  },
  {
    name: 'a neighboring function',
    body: 'export const BackButton = () => null; export const Other = () => cache(16);',
  },
  {
    name: 'a nested function',
    body: 'export function BackButton() { return () => cache(16); }',
  },
  {
    name: 'a wrapper imported from another module',
    body: "import { memo } from './other'; export const BackButton = memo(() => cache(16));",
  },
  {
    name: 'a shadowed React wrapper',
    body: "import { memo } from 'react'; const React = { memo }; const memoLike = (fn) => fn; const ReactAlias = { memo: memoLike }; export const BackButton = ReactAlias.memo(() => cache(16));",
  },
  {
    name: 'an uncompiled wrapped function next to a compiled function',
    body: "import { memo } from 'react'; export const Other = () => cache(16); export const BackButton = memo(() => null);",
  },
  {
    name: 'a cycle of local wrappers',
    body: "import { memo } from 'react'; const Button = memo(BackButton); export const BackButton = memo(Button);",
  },
  {
    name: 'a type-only export',
    body: 'const Button = () => cache(16); export type { Button as BackButton };',
  },
  {
    name: 'a re-export',
    body: "const Button = () => cache(16); export { Button as BackButton } from './other';",
  },
])('rejects a cache call from $name', async ({ body }) => {
  await expect(
    backButtonUsesCompilerCache(entry, `${cacheImport} ${body}`)
  ).resolves.toBe(false);
});
