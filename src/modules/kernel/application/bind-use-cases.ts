export type UseCaseScope<D> = <I, O>(
  deps: D,
  input: I,
  operation: (deps: D, input: I) => Promise<O>
) => Promise<O>;
type Operations<D> = Record<
  string,
  (deps: D, input: never) => Promise<unknown>
>;
type Bound<T extends Operations<never>> = {
  [K in keyof T]: (input: Parameters<T[K]>[1]) => ReturnType<T[K]>;
};

/** Definitions are bound once; each call receives its own optional dependency scope. */
export function bindUseCases<D, T extends Operations<D>>(
  deps: D,
  definitions: T,
  scope?: UseCaseScope<D>
): Bound<T> {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, operation]) => [
      name,
      (input: never) =>
        scope ? scope(deps, input, operation) : operation(deps, input),
    ])
  ) as Bound<T>;
}
