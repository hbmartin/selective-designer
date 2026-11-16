import ts from 'typescript';
import { normalizePath, type Plugin } from 'vite';

function backButtonUsesCompilerCache(file: string, code: string): boolean {
  const syntax = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX
  );
  // Resolve bindings in the transformed module without loading its imports.
  const options = { noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === file ? syntax : undefined);
  const checker = ts.createProgram([file], options, host).getTypeChecker();
  const cacheBindings = new Set<ts.Symbol>();
  let body: ts.ConciseBody | undefined;

  for (const statement of syntax.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'react/compiler-runtime'
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if ((binding.propertyName ?? binding.name).text !== 'c') continue;
          const symbol = checker.getSymbolAtLocation(binding.name);
          if (symbol) cacheBindings.add(symbol);
        }
      }
    }

    if (
      !ts.canHaveModifiers(statement) ||
      !ts
        .getModifiers(statement)
        ?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue;
    }
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'BackButton'
    ) {
      body = statement.body;
    }
    if (ts.isVariableStatement(statement)) {
      for (const { name, initializer } of statement.declarationList
        .declarations) {
        if (
          ts.isIdentifier(name) &&
          name.text === 'BackButton' &&
          initializer &&
          (ts.isArrowFunction(initializer) ||
            ts.isFunctionExpression(initializer))
        ) {
          body = initializer.body;
        }
      }
    }
  }

  if (!body || cacheBindings.size === 0) return false;
  const pending: ts.Node[] = [body];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    if (ts.isFunctionLike(node)) continue;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const [size] = node.arguments;
      const symbol = checker.getSymbolAtLocation(node.expression);
      if (
        symbol &&
        cacheBindings.has(symbol) &&
        node.arguments.length === 1 &&
        size &&
        ts.isNumericLiteral(size) &&
        Number(size.text) > 0
      ) {
        return true;
      }
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return false;
}

export function verifyBackButtonCompiler(backButtonFile: string): Plugin {
  const file = normalizePath(backButtonFile);
  let hasCache = false;
  return {
    name: 'selective-designer:verify-back-button-compiler',
    apply: 'build',
    applyToEnvironment: ({ config }) => config.consumer === 'client',
    enforce: 'post',
    buildStart() {
      hasCache = false;
    },
    transform(code, id) {
      if (normalizePath(id) === file) {
        hasCache = backButtonUsesCompilerCache(file, code);
      }
    },
    generateBundle(_, bundle) {
      const rendered = Object.values(bundle).some(
        (output) =>
          output.type === 'chunk' &&
          output.modules[file]?.renderedExports.includes('BackButton')
      );
      if (!rendered) {
        this.error('BackButton was not rendered in a client chunk.');
      }
      if (!hasCache) {
        this.error(
          'React Compiler did not emit a memo cache inside BackButton.'
        );
      }
      this.info(
        'Verified React Compiler cache and client export for BackButton.'
      );
    },
  };
}
