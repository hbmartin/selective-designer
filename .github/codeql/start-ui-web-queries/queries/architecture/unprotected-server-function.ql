/**
 * @name Privileged server function missing protected runner
 * @description Exported TanStack server functions should use the protected context or mutation runner unless they are explicitly public.
 * @kind problem
 * @problem.severity error
 * @precision high
 * @id start-ui-web/unprotected-server-function
 * @tags security
 *       external/cwe/cwe-862
 */

import javascript

private predicate isServerEntrypoint(File file) {
  file.getRelativePath().regexpMatch("src/modules/.+/(server|server-functions)\\.ts") or
  file.getRelativePath().regexpMatch("src/modules/.+/transport/server-functions/.+\\.ts") or
  file.getRelativePath().regexpMatch(".*unprotected-server-function\\.ts")
}

private predicate isPublicServerFunction(string name) {
  name = "configEnv" or
  name = "currentSession" or
  name = "initSsrApp"
}

private predicate isCreateServerFnChain(Expr expr) {
  exists(CallExpr call |
    call = expr.getAChild*() and
    (
      call.getCalleeName() = "createServerFn" or
      importsBinding(call.getCallee().(VarRef), "@tanstack/react-start", "createServerFn")
    )
  )
}

private predicate isProtectedRunnerProperty(string name) {
  name = "withProtectedContext" or
  name = "withProtectedMutation" or
  name = "withFreshProtectedMutation"
}

private predicate importsBinding(VarRef ref, string path, string name) {
  exists(NamedImportSpecifier spec |
    spec.getLocal().getVariable() = ref.getVariable() and
    spec.getImportDeclaration().getImportedPathExpr().getStringValue() = path and
    spec.getImportedName() = name and
    not spec.isTypeOnly() and
    not spec.getImportDeclaration().isTypeOnly()
  )
}

private Expr constInitializer(VarRef ref) {
  exists(ConstDeclStmt stmt, VariableDeclarator decl |
    decl = stmt.getADecl() and
    decl.getBindingPattern().(VarDecl).getVariable() = ref.getVariable() and
    not ref.getVariable().getAnAccess().isLValue() and
    result = decl.getInit()
  )
}

/** An immutable runner imported directly or unpacked by the dependency loader. */
private predicate isAuthBinding(VarRef ref, string name) {
  importsBinding(ref, "@/modules/auth/backend", name)
  or
  exists(ConstDeclStmt stmt, VariableDeclarator decl, ObjectPattern bindings, PropertyPattern prop,
    DynamicImportExpr source |
    decl = stmt.getADecl() and
    prop = bindings.getPropertyPatternByName(name) and
    prop.getValuePattern().(VarDecl).getVariable() = ref.getVariable() and
    not ref.getVariable().getAnAccess().isLValue() and
    source.getImportedPathExpr().getStringValue() = "@/modules/auth/backend" and
    (
      decl.getBindingPattern() = bindings and decl.getInit().(AwaitExpr).getOperand() = source
      or
      exists(int index, ArrayExpr imports, MethodCallExpr all |
        decl.getBindingPattern().(ArrayPattern).getElement(index) = bindings and
        decl.getInit().(AwaitExpr).getOperand() = all and
        all.getReceiver().(VarRef).getVariable().(GlobalVariable).getName() = "Promise" and
        all.getMethodName() = "all" and
        imports = all.getArgument(0) and
        imports.getElement(index) = source and
        not imports.getAnElement() instanceof SpreadElement
      )
    )
  )
}

private predicate exposesAuthRunner(VarRef getDeps, string name) {
  exists(CallExpr wrapper, Function loader, ReturnStmt returned, ObjectExpr deps, Property prop |
    wrapper = constInitializer(getDeps) and
    importsBinding(wrapper.getCallee().(VarRef), "@tanstack/react-start", "createServerOnlyFn") and
    loader = wrapper.getArgument(0) and
    returned = loader.getBody().(BlockStmt).getAStmt() and
    // The loader has one return, and its value is a plain object with unique keys.
    count(ReturnStmt ret | ret.getContainer() = loader) = 1 and
    deps = returned.getExpr() and
    prop = deps.getPropertyByName(name) and
    forall(Property field | field = deps.getAProperty() |
      exists(field.getName()) and not field.isComputed()
    ) and
    count(Property field | field = deps.getAProperty() and field.getName() = name) = 1 and
    isAuthBinding(prop.getInit().(VarRef), name)
  )
}

private predicate invokesInstrumentedProtectedRunner(CallExpr call) {
  exists(MethodCallExpr operation, VarRef runner, CallExpr factory, ObjectExpr options,
    Function selector, PropAccess selected, string name |
    call.getCallee().stripParens() = operation and
    operation.getMethodName() = "withOperation" and
    operation.getReceiver() = runner and
    factory = constInitializer(runner) and
    importsBinding(factory.getCallee().(VarRef),
      "@/platform/lib/tanstack-start/server-function-handler", "createServerFunctionInvoker") and
    // Keep the invoker local and prevent writes to its methods or escape through aliases.
    forall(VarAccess access | access = runner.getVariable().getAnAccess() |
      exists(MethodCallExpr use | use.getReceiver() = access and
        use.getMethodName() = "withOperation")
    ) and
    options = factory.getArgument(0) and
    options.getNumProperty() = 2 and
    selector = options.getPropertyByName("selectRunner").getInit() and
    selected = selector.getBody() and
    selected.getBase().(VarRef).getVariable() =
      selector.getParameter(0).(VarDecl).getVariable() and
    name = selected.getPropertyName() and
    isProtectedRunnerProperty(name) and
    exposesAuthRunner(options.getPropertyByName("getDeps").getInit().(VarRef), name)
  )
}

private Expr handlerResult(Function handler) {
  result = handler.getBody().(Expr)
  or
  exists(BlockStmt block |
    block = handler.getBody() and
    not exists(block.getStmt(1)) and
    result = block.getStmt(0).(ReturnStmt).getExpr()
  )
}

private predicate isTrustedBuilder(Expr expr) {
  exists(CallExpr create |
    create = expr.stripParens() and
    importsBinding(create.getCallee().(VarRef), "@tanstack/react-start", "createServerFn")
  )
  or
  exists(MethodCallExpr method |
    method = expr.stripParens() and
    method.getMethodName() = ["middleware", "validator", "inputValidator"] and
    isTrustedBuilder(method.getReceiver())
  )
}

private predicate usesProtectedRunner(Expr expr) {
  exists(MethodCallExpr handler, Expr returned, CallExpr call |
    handler = expr.stripParens() and
    handler.getMethodName() = "handler" and
    isTrustedBuilder(handler.getReceiver()) and
    returned = handlerResult(handler.getArgument(0).(Function)).stripParens() and
    (call = returned or call = returned.(AwaitExpr).getOperand().stripParens()) and
    (
      exists(string name |
        isProtectedRunnerProperty(name) and isAuthBinding(call.getCallee().(VarRef), name)
      )
      or
      invokesInstrumentedProtectedRunner(call)
    )
  )
}

from ExportDeclaration export, Variable variable, Expr assigned
where
  export.exportsDirectlyAs(variable, variable.getName()) and
  isServerEntrypoint(export.getFile()) and
  not isPublicServerFunction(variable.getName()) and
  assigned = variable.getAnAssignedExpr() and
  isCreateServerFnChain(assigned) and
  not usesProtectedRunner(assigned)
select assigned,
  "Exported server function '" + variable.getName() +
    "' is not routed through a protected server-function runner."
