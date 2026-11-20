import ts from 'typescript';

function staticName(node: ts.Node): string | undefined {
  if (ts.isComputedPropertyName(node)) return staticName(node.expression);
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  )
    return node.text;
  return undefined;
}

/** Inspect syntax only: these examples must never execute their process calls. */
export function unsafeFixtureSignals(source: string, file: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const allowed =
    file.replaceAll('\\', '/').replace(/^\.\//, '') ===
    'tests/support/fixture-process-groups.ts';
  const problems: string[] = [];
  const processNames = new Set(['process']);
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !['process', 'node:process'].includes(statement.moduleSpecifier.text)
    )
      continue;
    const clause = statement.importClause;
    if (clause?.name) processNames.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      processNames.add(clause.namedBindings.name.text);
    if (
      !allowed &&
      clause?.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.some(
        (entry) => (entry.propertyName ?? entry.name).text === 'kill'
      )
    )
      problems.push('Imported process signal bypasses verified fixture helper');
  }
  const property = (
    node: ts.Node
  ): { object: ts.Expression; name: string } | undefined => {
    if (ts.isPropertyAccessExpression(node))
      return { object: node.expression, name: node.name.text };
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
    )
      return { object: node.expression, name: node.argumentExpression.text };
    return undefined;
  };
  const nodes: ts.Node[] = [tree];
  while (nodes.length) {
    const node = nodes.pop()!;
    const access = property(node);
    if (
      !allowed &&
      access?.name === 'kill' &&
      ts.isIdentifier(access.object) &&
      processNames.has(access.object.text)
    )
      problems.push(
        'Process signaling or captured originals bypass verified fixture helper'
      );
    if (
      !allowed &&
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      processNames.has(node.initializer.text) &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some(
        (entry) => staticName(entry.propertyName ?? entry.name) === 'kill'
      )
    )
      problems.push(
        'Destructured process signaling bypasses verified fixture helper'
      );
    if (
      !allowed &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.right) &&
      processNames.has(node.right.text) &&
      ts.isObjectLiteralExpression(node.left) &&
      node.left.properties.some(
        (entry) => entry.name && staticName(entry.name) === 'kill'
      )
    ) {
      problems.push(
        'Assigned process signaling bypasses verified fixture helper'
      );
    }
    if (
      ts.isCallExpression(node) &&
      property(node.expression)?.name === 'spyOn'
    ) {
      const [target, method] = node.arguments;
      if (
        target &&
        ts.isIdentifier(target) &&
        processNames.has(target.text) &&
        method &&
        (ts.isStringLiteral(method) ||
          ts.isNoSubstitutionTemplateLiteral(method)) &&
        method.text === 'kill'
      ) {
        const parent = node.parent;
        const replacement = property(parent);
        if (
          !replacement ||
          !['mockImplementation', 'mockReturnValue'].includes(
            replacement.name
          ) ||
          !ts.isCallExpression(parent.parent) ||
          parent.parent.expression !== parent
        )
          problems.push(
            'Process kill spies require an immediate persistent replacement'
          );
      }
    }
    ts.forEachChild(node, (child) => {
      nodes.push(child);
    });
  }
  return problems;
}
