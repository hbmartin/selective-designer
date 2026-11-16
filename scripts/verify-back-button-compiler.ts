/// <reference lib="es2025.regexp" />

import type { Node, Symbol } from 'typescript';
import { normalizePath, type Plugin } from 'vite';

const reactWrappers = new Set(['memo', 'forwardRef']);

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
  const declaration = binding ? binding.valueDeclaration : undefined;
  let implementation: Node | undefined =
    declaration && ts.isVariableDeclaration(declaration)
      ? declaration.initializer
      : declaration;

  const cacheBindings = new Set<Symbol>();
  const wrapperBindings = new Set<Symbol>();
  const reactBindings = new Set<Symbol>();

  for (const statement of syntax.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const moduleName = statement.moduleSpecifier.text;
    const { importClause } = statement;
    if (!importClause || importClause.isTypeOnly) continue;
    const { namedBindings } = importClause;
    if (moduleName === 'react') {
      const reactName =
        namedBindings && ts.isNamespaceImport(namedBindings)
          ? namedBindings.name
          : undefined;
      for (const identifier of [importClause.name, reactName]) {
        const symbol = identifier && checker.getSymbolAtLocation(identifier);
        if (symbol) reactBindings.add(symbol);
      }
    }
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    for (const namedImport of namedBindings.elements) {
      if (namedImport.isTypeOnly) continue;
      const name = (namedImport.propertyName ?? namedImport.name).text;
      const symbol = checker.getSymbolAtLocation(namedImport.name);
      if (!symbol) continue;
      if (moduleName === 'react/compiler-runtime' && name === 'c')
        cacheBindings.add(symbol);
      if (moduleName === 'react' && reactWrappers.has(name))
        wrapperBindings.add(symbol);
      if (moduleName === 'react' && name === 'default')
        reactBindings.add(symbol);
    }
  }

  if (cacheBindings.size === 0) return false;

  const seen = new Set<Node>();
  while (implementation && !seen.has(implementation)) {
    seen.add(implementation);
    if (
      ts.isFunctionDeclaration(implementation) ||
      ts.isArrowFunction(implementation) ||
      ts.isFunctionExpression(implementation)
    )
      break;
    if (ts.isParenthesizedExpression(implementation)) {
      implementation = implementation.expression;
      continue;
    }
    if (ts.isIdentifier(implementation)) {
      const local =
        checker.getSymbolAtLocation(implementation)?.valueDeclaration;
      if (!local || local.getSourceFile() !== syntax) return false;
      if (ts.isFunctionDeclaration(local)) {
        implementation = local;
      } else if (
        ts.isVariableDeclaration(local) &&
        ts.isVariableDeclarationList(local.parent) &&
        (local.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        implementation = local.initializer;
      } else {
        return false;
      }
      continue;
    }
    if (!ts.isCallExpression(implementation)) return false;
    const { expression } = implementation;
    if (ts.isIdentifier(expression)) {
      const wrapper = checker.getSymbolAtLocation(expression);
      if (!wrapper || !wrapperBindings.has(wrapper)) return false;
    } else if (
      ts.isPropertyAccessExpression(expression) &&
      reactWrappers.has(expression.name.text)
    ) {
      const react = checker.getSymbolAtLocation(expression.expression);
      if (!react || !reactBindings.has(react)) return false;
    } else {
      return false;
    }
    implementation = implementation.arguments[0];
  }
  if (
    !implementation ||
    (!ts.isFunctionDeclaration(implementation) &&
      !ts.isArrowFunction(implementation) &&
      !ts.isFunctionExpression(implementation)) ||
    !implementation.body
  )
    return false;

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
  const exactId = new RegExp(`^${RegExp.escape(file)}$`);
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
      async handler(code) {
        hasCache = await backButtonUsesCompilerCache(file, code);
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
