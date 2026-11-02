import type { Result } from '@bloodyowl/boxed';

/** Unwrap an `Ok` value in tests, failing loudly on `Error`. */
export function okValue<TValue, TError>(
  result: Result<TValue, TError>
): TValue {
  if (result.isError()) {
    throw new Error(
      `Expected Result.Ok, got Result.Error: ${String(result.getError())}`
    );
  }
  return result.get();
}

/** Unwrap an `Error` value in tests, failing loudly on `Ok`. */
export function errorValue<TValue, TError>(
  result: Result<TValue, TError>
): TError {
  if (result.isOk()) {
    throw new Error(
      `Expected Result.Error, got Result.Ok: ${JSON.stringify(result.get())}`
    );
  }
  return result.getError();
}
