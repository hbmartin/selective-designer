import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const backButtonLabel = 'components:backButton.label';

function unwrapParentheses(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function callTarget(expression) {
  const target = unwrapParentheses(expression);
  // Rolldown emits (0, alias.c)(size) to call the function without a receiver.
  if (
    ts.isBinaryExpression(target) &&
    target.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    ts.isNumericLiteral(target.left) &&
    target.left.text === '0'
  ) {
    return unwrapParentheses(target.right);
  }
  return target;
}

function findCompilerRuntimeBindings(syntax, checker) {
  const runtimeFactories = new Set();
  const runtimes = new Set();
  for (const node of syntax.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !node.moduleSpecifier.text.startsWith('.') ||
      !/^compiler-runtime(?:-[^/]+)?\.js$/.test(
        path.posix.basename(node.moduleSpecifier.text)
      )
    ) {
      continue;
    }
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const factory = checker.getSymbolAtLocation(binding.name);
        if (factory) runtimeFactories.add(factory);
      }
    }
  }

  for (const node of syntax.statements) {
    if (!ts.isVariableStatement(node)) continue;
    for (const declaration of node.declarationList.declarations) {
      const { name, initializer } = declaration;
      if (!ts.isIdentifier(name) || !initializer) continue;
      const value = unwrapParentheses(initializer);
      if (!ts.isCallExpression(value) || value.arguments.length !== 0) continue;
      const target = callTarget(value.expression);
      if (
        ts.isIdentifier(target) &&
        runtimeFactories.has(checker.getSymbolAtLocation(target))
      ) {
        const runtime = checker.getSymbolAtLocation(name);
        if (runtime) runtimes.add(runtime);
      }
    }
  }
  return runtimes;
}

function isMemoCacheAllocation(node, runtimes, checker) {
  if (!ts.isCallExpression(node)) return false;
  const target = callTarget(node.expression);
  const [size] = node.arguments;
  return (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.name.text === 'c' &&
    node.arguments.length === 1 &&
    size !== undefined &&
    ts.isNumericLiteral(size) &&
    Number(size.text) > 0 &&
    runtimes.has(checker.getSymbolAtLocation(target.expression))
  );
}

function findBackButtonFunctions(file, source) {
  const fileName = path.resolve(file).split(path.sep).join('/');
  const syntax = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  );

  // Local symbol resolution only needs this chunk, even for its import aliases.
  const options = { allowJs: true, noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === fileName ? syntax : undefined);
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();
  const runtimes = findCompilerRuntimeBindings(syntax, checker);
  const functions = [];
  const pending = [{ node: syntax, enclosingFunction: undefined }];
  while (pending.length > 0) {
    const { node, enclosingFunction } = pending.pop();
    let current = enclosingFunction;
    if (ts.isFunctionLike(node)) {
      current = { hasLabel: false, hasMemoCache: false };
      functions.push(current);
    }

    if (current) {
      if (ts.isStringLiteralLike(node) && node.text === backButtonLabel)
        current.hasLabel = true;
      if (isMemoCacheAllocation(node, runtimes, checker))
        current.hasMemoCache = true;
    }

    ts.forEachChild(node, (child) => {
      pending.push({ node: child, enclosingFunction: current });
    });
  }
  return functions.filter(({ hasLabel }) => hasLabel);
}

const assetsDirectory = process.argv[2];
if (!assetsDirectory) {
  throw new Error(
    'Usage: pnpm test:react-compiler:production <assets-directory>'
  );
}

const backButtonFunctions = [];
for (const asset of readdirSync(assetsDirectory, { recursive: true })) {
  if (!asset.endsWith('.js')) continue;
  const file = path.join(assetsDirectory, asset);
  const source = readFileSync(file, 'utf8');
  if (!source.includes(backButtonLabel)) continue;

  for (const match of findBackButtonFunctions(file, source))
    backButtonFunctions.push({ file, ...match });
}

if (backButtonFunctions.length === 0) {
  throw new Error(
    `BackButton was not found in the client assets under ${assetsDirectory}.`
  );
}

const uncompiled = backButtonFunctions.filter(
  ({ hasMemoCache }) => !hasMemoCache
);
if (uncompiled.length > 0) {
  throw new Error(
    `BackButton is missing the React Compiler memo cache in ${uncompiled.map(({ file }) => file).join(', ')}.`
  );
}

console.log(
  `Verified React Compiler output for BackButton under ${assetsDirectory}.`
);
