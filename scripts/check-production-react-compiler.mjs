import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const backButtonLabel = 'components:backButton.label';
const memoCacheSentinel = 'react.memo_cache_sentinel';

function isMemoCacheSentinel(node) {
  if (!ts.isCallExpression(node)) return false;
  const {
    expression,
    arguments: [key],
  } = node;
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'Symbol' &&
    expression.name.text === 'for' &&
    key !== undefined &&
    ts.isStringLiteralLike(key) &&
    key.text === memoCacheSentinel
  );
}

function findBackButtonFunctions(file, source) {
  const matches = [];
  const syntax = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  );

  function visit(node, enclosingFunction) {
    const startsFunction = ts.isFunctionLike(node);
    const current = startsFunction
      ? { hasLabel: false, hasMemoCache: false }
      : enclosingFunction;

    if (current) {
      if (ts.isStringLiteralLike(node) && node.text === backButtonLabel)
        current.hasLabel = true;
      if (isMemoCacheSentinel(node)) current.hasMemoCache = true;
    }

    ts.forEachChild(node, (child) => visit(child, current));
    if (startsFunction && current.hasLabel) matches.push(current);
  }

  visit(syntax, undefined);
  return matches;
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
