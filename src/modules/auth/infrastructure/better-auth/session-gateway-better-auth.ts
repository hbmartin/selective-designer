import { Option, Result } from '@bloodyowl/boxed';
import { and, eq } from 'drizzle-orm';

import {
  AppError,
  type ApplicationResult,
  type Clock,
  toEmailAddress,
  toSessionId,
  toUserId,
  type UserId,
} from '@/modules/kernel';
import { systemClock } from '@/modules/kernel/infrastructure/clock/system-clock';
import { getBetterAuthConfig } from '@/modules/kernel/infrastructure/config/auth';
import {
  type Database,
  getDefaultDbClient,
} from '@/modules/kernel/infrastructure/db/client';
import type { TelemetryAdapter } from '@/platform/telemetry';

import type { Auth } from './auth';
import { getDefaultAuth } from './auth';
import { authIdentity, user as userTable } from '../drizzle/schema';
import type { SessionGateway } from '../../application/ports/session-gateway';
import { zRole } from '../../domain/permissions';
import type {
  AuthenticatedSession,
  AuthenticatedUser,
} from '../../domain/session';

type BetterAuthSession = NonNullable<
  Awaited<ReturnType<Auth['api']['getSession']>>
>;
type BetterAuthSessionRecord = BetterAuthSession['session'];

const authenticatedRole = zRole();
const defaultAuthenticatedRole = 'user' satisfies AuthenticatedUser['role'];

type AuthenticatedUserSource = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  emailVerified?: boolean;
  role?: unknown;
  onboardedAt?: Date | string | null;
};

const toAuthenticatedRole = (role: unknown): AuthenticatedUser['role'] => {
  const parsed = authenticatedRole.safeParse(role);
  return parsed.success ? parsed.data : defaultAuthenticatedRole;
};

const invalidAuthProviderResponse = (cause: unknown) =>
  new AppError({
    code: 'AUTH_SESSION_PROVIDER_RESPONSE_INVALID',
    category: 'system',
    status: 500,
    message: 'Auth session provider returned invalid data',
    cause,
  });

const toAuthenticatedUser = (
  user: AuthenticatedUserSource
): ApplicationResult<AuthenticatedUser> => {
  const id = toUserId(user.id);
  if (id.isError())
    return Result.Error(invalidAuthProviderResponse(id.getError()));

  const email = toEmailAddress(user.email);
  if (email.isError()) {
    return Result.Error(invalidAuthProviderResponse(email.getError()));
  }

  return Result.Ok({
    id: id.get(),
    email: email.get(),
    name: user.name,
    image: user.image,
    emailVerified: user.emailVerified,
    role: toAuthenticatedRole(user.role),
    onboardedAt: user.onboardedAt,
  });
};

const toAuthenticatedSession = (
  session: BetterAuthSessionRecord,
  userId?: string
): ApplicationResult<AuthenticatedSession> => {
  const id = toSessionId(session.id);
  if (id.isError())
    return Result.Error(invalidAuthProviderResponse(id.getError()));

  let parsedUserId: UserId | undefined;
  if (userId) {
    const result = toUserId(userId);
    if (result.isError()) {
      return Result.Error(invalidAuthProviderResponse(result.getError()));
    }
    parsedUserId = result.get();
  }

  return Result.Ok({
    id: id.get(),
    userId: parsedUserId,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
  });
};

export class SessionGatewayBetterAuth implements SessionGateway {
  constructor(
    private readonly auth: Auth = getDefaultAuth(),
    private readonly db: Database = getDefaultDbClient(),
    private readonly clock: Clock = systemClock,
    private readonly telemetry: Pick<TelemetryAdapter, 'startSpan'>
  ) {}

  /**
   * True when a session has lived past the absolute cap, regardless of how
   * often it was refreshed (`updateAge` keeps sliding `expiresAt` forward).
   * Missing or malformed `createdAt` fails closed because it cannot prove the
   * session is still inside the hard cap.
   */
  private isPastAbsoluteMax(createdAt: Date | string | null | undefined) {
    if (createdAt === null || createdAt === undefined) return true;
    const createdAtMs = new Date(createdAt).getTime();
    if (Number.isNaN(createdAtMs)) return true;
    const ageSeconds = (this.clock.now().getTime() - createdAtMs) / 1000;
    return ageSeconds > getBetterAuthConfig().sessionAbsoluteMaxInSeconds;
  }

  private async resolveAppUser(
    providerUser: AuthenticatedUserSource
  ): Promise<Option<AuthenticatedUserSource>> {
    const identity = await this.db.query.authIdentity.findFirst({
      where: and(
        eq(authIdentity.provider, 'better-auth'),
        eq(authIdentity.providerUserId, providerUser.id)
      ),
      columns: { userId: true },
    });
    const userId = identity?.userId ?? providerUser.id;
    if (!identity) {
      await this.db
        .insert(authIdentity)
        .values({
          provider: 'better-auth',
          providerUserId: providerUser.id,
          userId: providerUser.id,
        })
        .onConflictDoNothing();
    }
    if (userId === providerUser.id) return Option.Some(providerUser);

    const appUser = await this.db.query.user.findFirst({
      where: eq(userTable.id, userId),
    });

    return Option.fromNullable(appUser);
  }

  async getSession(input: {
    headers: Headers;
  }): ReturnType<SessionGateway['getSession']> {
    return this.telemetry.startSpan(
      {
        attributes: {
          'auth.provider': 'better-auth',
          'operation.name': 'auth.getSession',
          'operation.type': 'provider_operation',
        },
        name: 'auth.getSession',
        op: 'auth.provider',
      },
      async () => {
        try {
          const session = await this.auth.api.getSession({
            headers: input.headers,
          });
          if (!session?.user || !session.session) {
            return Result.Ok({ type: 'auth_session_missing' });
          }
          if (this.isPastAbsoluteMax(session.session.createdAt)) {
            return Result.Ok({ type: 'auth_session_missing' });
          }
          return (await this.resolveAppUser(session.user)).match({
            None: () => Result.Ok({ type: 'auth_session_missing' as const }),
            Some: (user) => {
              const parsedUser = toAuthenticatedUser(user);
              if (parsedUser.isError())
                return Result.Error(parsedUser.getError());

              const parsedSession = toAuthenticatedSession(
                session.session,
                user.id
              );
              if (parsedSession.isError()) {
                return Result.Error(parsedSession.getError());
              }

              return Result.Ok({
                type: 'auth_session_found' as const,
                session: {
                  user: parsedUser.get(),
                  session: parsedSession.get(),
                },
              });
            },
          });
        } catch (error) {
          return Result.Error(
            error instanceof AppError
              ? error
              : new AppError({
                  code: 'AUTH_SESSION_GATEWAY_ERROR',
                  category: 'system',
                  status: 500,
                  message: 'Auth session gateway error',
                  cause: error,
                })
          );
        }
      }
    );
  }
}
