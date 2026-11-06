import { errorCauses } from './error-causes';

/** Prefer a semantic cause; otherwise keep a diagnostic SQLSTATE/transport identifier. */
export function actionableErrorCode(error: unknown, fallback: string) {
  const codes = [...errorCauses(error)].flatMap((cause) =>
    typeof cause.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(cause.code)
      ? [cause.code]
      : []
  );
  return (
    codes.find(
      (code) =>
        code.includes('_') &&
        !['PROVIDER_ACCOUNTING_FAILED', 'PROVIDER_CALL_LOG_FAILED'].includes(
          code
        )
    ) ??
    codes.find((code) => /^(?:[0-9A-Z]{5}|E[A-Z0-9]+)$/u.test(code)) ??
    fallback
  );
}
