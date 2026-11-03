import { useMatches } from '@tanstack/react-router';

import {
  type CurrentSession,
  hasRolePermission,
  parseRole,
  type Permission,
  type Role,
} from '@/modules/auth';

import { betterAuthBrowserClient } from './better-auth-client';

type AuthProviderError = {
  code?: string | null;
  message?: string | null;
};

type AuthProviderResponse<TData = unknown> = {
  data?: TData | null;
  error?: AuthProviderError | null;
};

export type AuthClientResult<TValue = void> =
  | { ok: true; value: TValue }
  | { ok: false; code: string; message?: string };

const authUnknownErrorCode = 'UNKNOWN_ERROR';
const authSignOutErrorCode = 'SIGN_OUT_FAILED';

const providerErrorResult = (
  error: AuthProviderError | null | undefined
): AuthClientResult<never> => ({
  ok: false,
  code: error?.code || authUnknownErrorCode,
  ...(error?.message ? { message: error.message } : {}),
});

const unknownErrorResult = (error: unknown): AuthClientResult<never> => ({
  ok: false,
  code: authUnknownErrorCode,
  message: error instanceof Error ? error.message : undefined,
});

const mapProviderResponse = <TValue, TData = unknown>(
  response: AuthProviderResponse<TData>,
  value: TValue
): AuthClientResult<TValue> =>
  response.error ? providerErrorResult(response.error) : { ok: true, value };

type AuthRouteSessionContext = {
  currentSession?: unknown;
};

const selectRouteCurrentSession = (
  matches: ReadonlyArray<{ context?: unknown }>
) => {
  for (const match of [...matches].reverse()) {
    const context = match.context as AuthRouteSessionContext | undefined;

    if (context && 'currentSession' in context) {
      return context.currentSession ?? null;
    }
  }

  return undefined;
};

const useRouteCurrentSession = () =>
  useMatches({
    select: (matches): CurrentSession | null | undefined =>
      selectRouteCurrentSession(
        matches as ReadonlyArray<{ context?: unknown }>
      ) as CurrentSession | null | undefined,
    structuralSharing: false,
  });

export const createUseAuthSession =
  <TQueryResult>(
    useCurrentSessionQuery: (
      initialData?: CurrentSession | null
    ) => TQueryResult
  ) =>
  () => {
    const routeSession = useRouteCurrentSession();
    return useCurrentSessionQuery(routeSession);
  };

export const startSignIn = async (input: {
  email: string;
  password: string;
}): Promise<AuthClientResult<void>> => {
  try {
    const response = await betterAuthBrowserClient.signInWithPassword(input);
    return mapProviderResponse(response, undefined);
  } catch (error) {
    return unknownErrorResult(error);
  }
};

export const signOut = async (): Promise<AuthClientResult<void>> => {
  try {
    const response = await fetch('/logout', {
      credentials: 'same-origin',
      method: 'POST',
    });

    if (!response.ok) {
      return {
        ok: false,
        code: authSignOutErrorCode,
        message: response.statusText || `HTTP error ${response.status}`,
      };
    }

    return { ok: true, value: undefined };
  } catch (error) {
    return unknownErrorResult(error);
  }
};

export const checkRolePermission = (input: {
  role: Role | string | null | undefined;
  permissions: Permission;
}) => {
  const role = parseRole(input.role);
  return role ? hasRolePermission(role, input.permissions) : false;
};

export { authErrorCodes } from './better-auth-client';
