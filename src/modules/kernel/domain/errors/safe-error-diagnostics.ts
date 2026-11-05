/** Diagnostic identifiers only: messages and URLs can contain credentials. */
export function safeErrorDiagnostics(error: unknown) {
  const names: string[] = [];
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (
      'name' in current &&
      typeof current.name === 'string' &&
      /^[\w]{1,64}$/u.test(current.name)
    )
      names.push(current.name);
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      /^[A-Z0-9_]{1,64}$/u.test(current.code)
    )
      codes.push(current.code);
    current = 'cause' in current ? current.cause : undefined;
  }
  return { errorNames: names, errorCodes: codes };
}
