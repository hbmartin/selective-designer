import { errorCauses } from './error-causes';

/** The SDK retains the original step error as a cause after retry exhaustion. */
export function failureCode(error: unknown, fallback: string): string {
  for (const cause of errorCauses(error)) {
    if (
      typeof cause.code === 'string' &&
      /^[A-Z][A-Z0-9_]{2,63}$/u.test(cause.code)
    )
      return cause.code;
    if (typeof cause.message === 'string') {
      const code = /^([A-Z][A-Z0-9_]{2,63}):/u.exec(cause.message)?.[1];
      if (code) return code;
    }
  }
  return fallback;
}
