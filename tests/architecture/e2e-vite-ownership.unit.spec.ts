import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

function inspect(source: string) {
  const file = ts.createSourceFile(
    'fixture.ts',
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const factories = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'vite' ||
      statement.importClause?.isTypeOnly
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings))
      namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements)
        if (
          !item.isTypeOnly &&
          (item.propertyName ?? item.name).text === 'createServer'
        )
          factories.add(item.name.text);
  }
  const findings = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && factories.has(callee.text))
        findings.add('creation');
      if (ts.isPropertyAccessExpression(callee)) {
        if (
          ts.isIdentifier(callee.expression) &&
          namespaces.has(callee.expression.text) &&
          callee.name.text === 'createServer'
        )
          findings.add('creation');
        if (['_closeServer', '_setInternalServer'].includes(callee.name.text))
          findings.add('private');
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const target = node.left;
      if (target.name.text === 'getSortedPluginHooks') findings.add('private');
      if (
        target.name.text === 'close' &&
        ts.isPropertyAccessExpression(target.expression) &&
        target.expression.name.text === 'watcher'
      )
        findings.add('watcher');
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...findings].sort();
}
it.each([
  ["import {createServer as launch} from 'vite'; launch({});", ['creation']],
  ["import * as vite from 'vite'; vite.createServer({});", ['creation']],
  ["import {createServer} from 'node:http'; createServer();", []],
  [
    "import type {createServer} from 'vite'; type Factory = typeof createServer;",
    [],
  ],
  ['server.watcher.close = replacement;', ['watcher']],
  ['server._closeServer("close");', ['private']],
  ['config.getSortedPluginHooks = replacement;', ['private']],
  ['const inert = "server._closeServer()";', []],
] as const)('checks inert lifecycle syntax: %s', (source, expected) => {
  expect(inspect(source)).toEqual(expected);
});
it('keeps literal Vite lifecycle effects inside the owner and explicit fault fixtures', async () => {
  async function scan(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(file);
        continue;
      }
      if (
        !entry.isFile() ||
        !/\.(?:[cm]?[jt]sx?)$/.test(entry.name) ||
        /\.d\.[cm]?ts$/.test(entry.name)
      )
        continue;
      const relative = path
        .relative(process.cwd(), file)
        .replaceAll(path.sep, '/');
      const faults = inspect(await readFile(file, 'utf8')).filter((finding) => {
        if (finding === 'private') return true;
        if (relative.endsWith('.fixture.ts')) return false;
        return (
          relative !==
          (finding === 'creation'
            ? 'tests/server/e2e-webserver.ts'
            : 'tests/server/vite-resource-observer.ts')
        );
      });
      expect({ file: relative, faults }).toEqual({
        file: relative,
        faults: [],
      });
    }
  }
  await scan(path.resolve('tests/server'));
  await scan(path.resolve('tests/support'));
});
