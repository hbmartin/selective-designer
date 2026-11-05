import { errorCauses } from './error-causes';

/** Diagnostic identifiers only: messages and URLs can contain credentials. */
export function safeErrorDiagnostics(error: unknown) {
  const names: string[] = [];
  const codes: string[] = [];
  for (const current of errorCauses(error)) {
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
  }
  return { errorNames: names, errorCodes: codes };
}
