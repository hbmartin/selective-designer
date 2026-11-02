import { Result } from '@bloodyowl/boxed';
import { getGlobalStartContext } from '@tanstack/react-start';
import {
  getRequestHeaders,
  setResponseHeader,
} from '@tanstack/react-start/server';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { match, P } from 'ts-pattern';

import type {
  AuthenticatedSession,
  AuthenticatedUser,
  AuthSession,
  AuthUseCases,
  Permission,
  RequestScope,
} from '@/modules/auth';
import {
  AUTH_REAUTH_REQUIRED,
  isSessionFresh,
  scopeFromUser,
  scopeKeyFromScope,
} from '@/modules/auth';
import {
  createRequestLogger,
  type Logger,
  type LogLevel,
  toRequestId,
  type UserId,
} from '@/modules/kernel';
import { getBetterAuthConfig } from '@/modules/kernel/backend';
import {
  isServerFnError,
  SERVER_FN_ERROR_CODES,
  ServerFnError,
  type ServerFnErrorCode,
  type ServerFnErrorData,
} from '@/modules/kernel/server';
import { timingStore } from '@/modules/kernel/transport/tanstack/timing-store';
import { cachePrivateNoStore } from '@/platform/http/cache-control';
import type { TelemetryAdapter } from '@/platform/telemetry';
import { createNoOpTelemetry } from '@/platform/telemetry';

type ServerTimingEntry = { name: string; durationMs: number };

export type ProcedureLogger = Logger;

export type ProtectedContext = {
  user: AuthenticatedUser;
  session: AuthenticatedSession;
  scope: RequestScope;
  logger: ProcedureLogger;
};

export type PublicContext = Omit<
  ProtectedContext,
  'user' | 'session' | 'scope'
> & {
  user: AuthenticatedUser | null;
  session: AuthenticatedSession | null;
  scope: RequestScope | null;
};

type ServerContextDeps = {
  getAuthUseCases: () => AuthUseCases;
  logger?: Logger;
  telemetry?: TelemetryAdapter;
  /**
   * Step-up freshness window in seconds. Defaults to the Better Auth config so
   * production wiring stays a no-op; tests override it with a fixed value.
   */
  getSessionFreshAgeSeconds?: () => number;
  /**
   * Framework-boundary clock for the freshness check. AGENTS.md allows a direct
   * `Date.now()` here; tests override it with a fixed instant.
   */
  now?: () => number;
};

type AppStartRequestContextLike = {
  requestId?: unknown;
  auth?: {
    getSession?: () => Promise<AuthSession | null>;
  };
};

const noOpLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const formatTiming = (entries: ServerTimingEntry[]) =>
  entries.map((e) => `${e.name};dur=${e.durationMs.toFixed(2)}`).join(', ');

const appendServerTiming = (entries: ServerTimingEntry[]) => {
  if (!entries.length) return;
  setResponseHeader('Server-Timing', formatTiming(entries));
};

const setAuthenticatedResponseCacheHeaders = () => {
  setResponseHeader('Cache-Control', cachePrivateNoStore());
  setResponseHeader('Vary', 'Cookie, Authorization');
};

const finalize = (
  procedureLogger: ProcedureLogger,
  timings: ServerTimingEntry[],
  start: number
) => {
  const totalDuration = performance.now() - start;
  procedureLogger.info({
    event: 'server_fn.request.finish',
    direction: 'inbound',
    durationMs: totalDuration,
  });

  const dbTimings = timingStore.getStore()?.db ?? [];
  const allTimings: ServerTimingEntry[] = [
    ...timings,
    ...dbTimings.map((t) => ({
      name: `db-${t.model}-${t.operation}`,
      durationMs: t.duration,
    })),
    { name: 'global', durationMs: totalDuration },
  ];
  appendServerTiming(allTimings);
};

const handleError = (error: unknown, procedureLogger: ProcedureLogger) => {
  const mappedError = mapTransportError(error);
  const shouldLogOriginalError =
    mappedError instanceof ServerFnError &&
    mappedError.message === 'Unhandled error' &&
    mappedError !== error;

  if (shouldLogOriginalError) {
    procedureLogger.error({
      event: 'server_fn.error.unhandled',
      direction: 'inbound',
      error:
        error instanceof Error
          ? error.message
          : 'Unhandled error before mapping',
      exception: error,
    });
  }

  const logLevel: LogLevel = (() => {
    if (!(mappedError instanceof Error)) return 'error';
    if (mappedError instanceof ServerFnError) {
      if (mappedError.status >= 500) return 'error';
      if (mappedError.status >= 400) return 'warn';
      if (mappedError.status >= 300) return 'info';
    }
    return 'error';
  })();
  if (
    mappedError instanceof ServerFnError &&
    (mappedError.code === 'UNAUTHORIZED' || mappedError.code === 'FORBIDDEN')
  ) {
    procedureLogger.warn({
      event: 'security.authz_denied',
      direction: 'inbound',
      details: {
        code: mappedError.code,
        status: mappedError.status,
      },
    });
  }
  procedureLogger[logLevel]({
    event: 'server_fn.error.mapped',
    direction: 'inbound',
    error: mappedError instanceof Error ? mappedError.message : 'Unknown error',
    details:
      mappedError instanceof ServerFnError
        ? {
            code: mappedError.code,
            data: mappedError.data,
            status: mappedError.status,
          }
        : { value: mappedError },
  });

  return mappedError;
};

const serverFnErrorCodes = new Set<ServerFnErrorCode>(SERVER_FN_ERROR_CODES);

const isServerFnErrorCode = (code: unknown): code is ServerFnErrorCode =>
  typeof code === 'string' && serverFnErrorCodes.has(code as ServerFnErrorCode);

const getServerFnErrorCode = (
  error: unknown
): ServerFnErrorCode | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return isServerFnErrorCode(code) ? code : undefined;
};

const getServerFnErrorData = (error: unknown) => {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  return typeof data === 'object' && data !== null
    ? (data as ServerFnErrorData)
    : undefined;
};

function mapTransportError(error: unknown): unknown {
  if (error instanceof ServerFnError) return error;
  const code =
    isServerFnError(error) && isServerFnErrorCode(error.code)
      ? error.code
      : getServerFnErrorCode(error);
  if (code) {
    return new ServerFnError(code, {
      data: getServerFnErrorData(error),
      message: error instanceof Error ? error.message : code,
    });
  }
  return new ServerFnError('INTERNAL_SERVER_ERROR', {
    message: 'Unhandled error',
  });
}

const getStartRequestContext = (): AppStartRequestContextLike | undefined => {
  try {
    const context = getGlobalStartContext();
    return context !== null && typeof context === 'object'
      ? context
      : undefined;
  } catch {
    return undefined;
  }
};

const getStartRequestId = () => {
  const requestId = getStartRequestContext()?.requestId;
  if (typeof requestId !== 'string') return undefined;

  const parsed = toRequestId(requestId);
  return parsed.isOk() ? parsed.get() : undefined;
};

const getStartAuthSession = () => {
  const auth = getStartRequestContext()?.auth;
  return typeof auth?.getSession === 'function' ? auth.getSession() : undefined;
};

const requestIdFromRuntime = () => {
  const startRequestId = getStartRequestId();
  if (startRequestId) return startRequestId;

  const parsed = toRequestId(randomUUID());
  if (parsed.isOk()) return parsed.get();

  const fallback = toRequestId(randomUUID());
  if (fallback.isOk()) return fallback.get();

  throw new ServerFnError('INTERNAL_SERVER_ERROR');
};

const getSessionCreatedAtMs = (
  createdAt: AuthenticatedSession['createdAt'] | null
) => {
  if (createdAt === undefined || createdAt === null) return undefined;
  const createdAtMs =
    createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return Number.isFinite(createdAtMs) ? createdAtMs : undefined;
};

export const createServerContextTools = ({
  getAuthUseCases,
  logger = noOpLogger,
  telemetry = createNoOpTelemetry(),
  getSessionFreshAgeSeconds = () =>
    getBetterAuthConfig().sessionFreshAgeInSeconds,
  now = () => Date.now(),
}: ServerContextDeps) => {
  const getSession = async (timings: ServerTimingEntry[]) => {
    const authStart = performance.now();
    const startSession = await getStartAuthSession();
    if (startSession !== undefined) {
      timings.push({ name: 'auth', durationMs: performance.now() - authStart });
      return startSession;
    }

    const result = await getAuthUseCases().getCurrentSession({
      headers: getRequestHeaders(),
    });
    timings.push({ name: 'auth', durationMs: performance.now() - authStart });
    return match(result)
      .with(Result.P.Error(P.select()), (error) => {
        throw error;
      })
      .with(
        Result.P.Ok({ type: 'auth_session_found', session: P.select() }),
        (session) => session
      )
      .with(Result.P.Ok({ type: 'auth_session_missing' }), () => null)
      .exhaustive();
  };

  const withPublicContext = async <T>(
    fn: (ctx: PublicContext) => Promise<T>
  ): Promise<T> => {
    const start = performance.now();
    const requestId = requestIdFromRuntime();
    const timings: ServerTimingEntry[] = [];
    let procedureLogger = createRequestLogger({ logger, requestId });
    procedureLogger.info({
      event: 'server_fn.request.start',
      direction: 'inbound',
    });

    return timingStore.run({ db: [] }, async () => {
      try {
        const session = await getSession(timings);
        if (session?.user?.id) {
          setAuthenticatedResponseCacheHeaders();
          telemetry.setUser({
            id: session.user.id,
            email: session.user.email,
            role: session.user.role,
          });
          const scope = scopeFromUser(session.user);
          const scopeKey = scopeKeyFromScope(scope);
          if (scopeKey.isError()) throw scopeKey.getError();
          procedureLogger = createRequestLogger({
            logger,
            requestId,
            userId: session.user.id,
            sessionId: session.session.id,
            scopeKey: scopeKey.get(),
          });
        } else {
          telemetry.setUser(null);
        }

        const ctx: PublicContext = {
          user: session?.user ?? null,
          session: session?.session ?? null,
          scope: session?.user ? scopeFromUser(session.user) : null,
          logger: procedureLogger,
        };
        return await fn(ctx);
      } catch (error) {
        throw handleError(error, procedureLogger);
      } finally {
        finalize(procedureLogger, timings, start);
      }
    });
  };

  const withProtectedContext = async <T>(
    fn: (ctx: ProtectedContext) => Promise<T>
  ): Promise<T> => {
    return withPublicContext(async (ctx) => {
      if (!ctx.user || !ctx.session || !ctx.scope) {
        throw new ServerFnError('UNAUTHORIZED');
      }
      return fn({
        user: ctx.user,
        session: ctx.session,
        scope: ctx.scope,
        logger: ctx.logger,
      });
    });
  };

  const withProtectedMutation = async <T>(
    fn: (ctx: ProtectedContext) => Promise<T>
  ): Promise<T> => {
    return withProtectedContext(async (ctx) => {
      return fn(ctx);
    });
  };

  /**
   * Like `withProtectedMutation`, but additionally requires a *fresh* session
   * (recent original sign-in) before running destructive admin actions. A stale
   * session is rejected with a recognizable `reauth_required` signal so the
   * client can prompt a step-up re-authentication and retry. This never locks an
   * admin out: re-authenticating mints a new session with a fresh `createdAt`.
   */
  const withFreshProtectedMutation = async <T>(
    fn: (ctx: ProtectedContext) => Promise<T>
  ): Promise<T> => {
    return withProtectedMutation(async (ctx) => {
      const fresh = isSessionFresh({
        createdAtMs: getSessionCreatedAtMs(ctx.session.createdAt),
        freshAgeSeconds: getSessionFreshAgeSeconds(),
        now: now(),
      });
      if (!fresh) {
        ctx.logger.warn({
          event: 'security.reauth_required',
          direction: 'inbound',
        });
        throw new ServerFnError('FORBIDDEN', {
          data: { reason: AUTH_REAUTH_REQUIRED },
        });
      }
      return fn(ctx);
    });
  };

  const assertPermission = async (userId: UserId, permissions: Permission) => {
    const result = await getAuthUseCases().checkPermission({
      userId,
      permissions,
      headers: getRequestHeaders(),
    });
    return match(result)
      .with(Result.P.Error(P.select()), (error) => {
        throw error;
      })
      .with(Result.P.Ok({ type: 'auth_permission_granted' }), () => undefined)
      .with(Result.P.Ok(P._), () => {
        throw new ServerFnError('FORBIDDEN');
      })
      .exhaustive();
  };

  return {
    assertPermission,
    withFreshProtectedMutation,
    withProtectedContext,
    withProtectedMutation,
    withPublicContext,
  };
};

export type ServerContextTools = ReturnType<typeof createServerContextTools>;
