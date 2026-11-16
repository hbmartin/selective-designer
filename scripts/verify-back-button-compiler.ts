import type { Node, Symbol } from 'typescript';
import { normalizePath, type Plugin } from 'vite';

export async function backButtonUsesCompilerCache(file: string, code: string) {
  const { default: ts } = await import('typescript');
  const fileName = normalizePath(file);
  const syntax = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX
  );
  // Resolve bindings in the transformed module without loading its imports.
  const options = { noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === fileName ? syntax : undefined);
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(syntax);
  if (!moduleSymbol) return false;

  const component = checker
    .getExportsOfModule(moduleSymbol)
    .find((entry) => entry.name === 'BackButton');
  const specifier = component?.declarations?.find(ts.isExportSpecifier);
  const binding = specifier
    ? !specifier.isTypeOnly &&
      !specifier.parent.parent.isTypeOnly &&
      !specifier.parent.parent.moduleSpecifier &&
      checker.getExportSpecifierLocalTargetSymbol(specifier)
    : component;
  const declaration = binding && binding.valueDeclaration;
  const implementation =
    declaration && ts.isVariableDeclaration(declaration)
      ? declaration.initializer
      : declaration;
  if (
    !implementation ||
    (!ts.isFunctionDeclaration(implementation) &&
      !ts.isArrowFunction(implementation) &&
      !ts.isFunctionExpression(implementation)) ||
    !implementation.body
  ) {
    return false;
  }

  const cacheBindings = new Set<Symbol>();

  for (const statement of syntax.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'react/compiler-runtime'
    ) {
      const bindings = statement.importClause?.isTypeOnly
        ? undefined
        : statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (
            binding.isTypeOnly ||
            (binding.propertyName ?? binding.name).text !== 'c'
          )
            continue;
          const symbol = checker.getSymbolAtLocation(binding.name);
          if (symbol) cacheBindings.add(symbol);
        }
      }
    }
  }

  if (cacheBindings.size === 0) return false;
  const pending: Node[] = [implementation.body];
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
  const exactId = new RegExp(
    '^' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
  );
  let hasCache = false;
  return {
    name: 'selective-designer:verify-back-button-compiler',
    apply: 'build',
    applyToEnvironment: ({ config }) => config.consumer === 'client',
    enforce: 'post',
    buildStart() {
      hasCache = false;
    },
    transform: {
      filter: { id: exactId },
      async handler(code, id) {
        if (normalizePath(id) === file) {
          hasCache = await backButtonUsesCompilerCache(file, code);
        }
      },
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
