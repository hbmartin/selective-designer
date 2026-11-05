/** Walk nested causes once, including hostile or cyclic wrapper graphs. */
export function* errorCauses(
  error: unknown
): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    yield current as Record<string, unknown>;
    current = 'cause' in current ? current.cause : undefined;
  }
}
