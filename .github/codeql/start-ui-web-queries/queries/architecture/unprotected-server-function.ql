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
    call.getCalleeName() = "createServerFn"
  )
}

private predicate isProtectedRunnerProperty(string name) {
  name = "withProtectedContext" or
  name = "withProtectedMutation" or
  name = "withFreshProtectedMutation"
}

private predicate isProtectedRunnerName(string name) {
  isProtectedRunnerProperty(name) or
  name = "runProtected" or
  name = "runMutation"
}

private predicate invokesInstrumentedProtectedRunner(CallExpr call) {
  exists(MethodCallExpr operation, VarRef runner, CallExpr factory, Property selection,
    Function selectRunner, PropAccess protectedRunner |
    call.getCallee().stripParens() = operation and
    operation.getMethodName() = "withOperation" and
    operation.getReceiver() = runner and
    runner.getVariable().getAnAssignedExpr() = factory and
    factory.getCalleeName() = "createServerFunctionInvoker" and
    factory.getArgument(0).(ObjectExpr).getAProperty() = selection and
    selection.getName() = "selectRunner" and
    selection.getInit() = selectRunner and
    selectRunner.getBody() = protectedRunner and
    protectedRunner.getBase().(VarRef).getVariable() =
      selectRunner.getParameter(0).getABindingVarRef().getVariable() and
    isProtectedRunnerProperty(protectedRunner.getPropertyName())
  )
}

private predicate usesProtectedRunner(Expr expr) {
  exists(CallExpr call |
    call = expr.getAChild*() and
    (isProtectedRunnerName(call.getCalleeName()) or invokesInstrumentedProtectedRunner(call))
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
