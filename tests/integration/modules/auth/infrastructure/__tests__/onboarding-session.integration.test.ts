import { makeUserRow } from '@tests/server/db-fixtures';
import { createRecoveryTestDatabase } from '@tests/server/recovery-database';
import { createUpstashRestFixture } from '@tests/server/upstash-rest-fixture';
import { testAccountName } from '@tests/support/branded-values';
import { okValue } from '@tests/support/result';
import { randomBytes } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  type Auth,
  createAuth,
} from '@/modules/auth/infrastructure/better-auth/auth';
import { writeOperatorPassword } from '@/modules/auth/infrastructure/better-auth/password-credentials';
import { SessionGatewayBetterAuth } from '@/modules/auth/infrastructure/better-auth/session-gateway-better-auth';
import { createAccountRepository } from '@/modules/auth/infrastructure/drizzle/account-repository-drizzle';
import { InMemorySecondaryStore } from '@/modules/auth/infrastructure/secondary-store/in-memory-secondary-store';
import {
  authIdentity,
  user as userTable,
} from '@/modules/auth/infrastructure/drizzle/schema';
import { toUserId } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import { envClient } from '@/platform/env/client';
import { createNoOpTelemetry } from '@/platform/telemetry';

describe('onboarding with cached auth sessions', () => {
  let database: Awaited<ReturnType<typeof createRecoveryTestDatabase>>;

  beforeAll(async () => {
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    database = await createRecoveryTestDatabase();
  });

  beforeEach(async () => {
    await database.reset();
  });

  afterAll(async () => {
    await database?.close();
    vi.unstubAllEnvs();
  });

  it.each(['memory', 'upstash'] as const)(
    'loads completed onboarding in the same session across instances using %s',
    async (backend) => {
      const fixture =
        backend === 'upstash' ? await createUpstashRestFixture() : undefined;
      const secondaryStore = fixture?.store ?? new InMemorySecondaryStore();
      const email = 'onboarding@example.com';
      const password = randomBytes(24).toString('hex');

      try {
        const auth = createAuth({ database: database.db, secondaryStore });
        const created = await writeOperatorPassword(database.db, {
          type: 'create',
          email,
          password,
          name: 'Original Name',
          role: 'user',
        });
        expect(created.type).toBe('password_set');
        if (created.type !== 'password_set')
          throw new Error('Provisioning failed');
        const userId = unwrapParseResult(toUserId(created.userId));
        const headers = new Headers({
          host: new URL(envClient.VITE_BASE_URL).host,
        });
        const response = await auth.api.signInEmail({
          asResponse: true,
          headers,
          body: { email, password },
        });
        expect(response.status).toBe(200);
        const cookie = response.headers
          .getSetCookie()
          .find((entry) => entry.startsWith('better-auth.session_token='))
          ?.split(';')[0];
        if (!cookie) throw new Error('Expected session cookie');
        headers.set('cookie', cookie);

        const gateway = new SessionGatewayBetterAuth(
          auth,
          database.db,
          undefined,
          createNoOpTelemetry()
        );
        const before = okValue(await gateway.getSession({ headers }));
        expect(before).toMatchObject({
          type: 'auth_session_found',
          session: { user: { onboardedAt: null } },
        });

        const onboardedAt = new Date('2026-11-19T12:00:00.000Z');
        const repository = createAccountRepository({ db: database.db });
        expect(
          okValue(
            await repository.submitOnboarding(userId, {
              name: testAccountName('Updated Name'),
              onboardedAt,
            })
          ).type
        ).toBe('account_updated');

        // The provider's session snapshot is deliberately still stale.
        expect((await auth.api.getSession({ headers }))?.user).toMatchObject({
          name: 'Original Name',
          onboardedAt: null,
        });
        const secondAuth = createAuth({
          database: database.db,
          secondaryStore,
        });
        const secondGateway = new SessionGatewayBetterAuth(
          secondAuth,
          database.db,
          undefined,
          createNoOpTelemetry()
        );
        for (const reader of [gateway, secondGateway]) {
          const current = okValue(await reader.getSession({ headers }));
          expect(current).toMatchObject({
            type: 'auth_session_found',
            session: {
              user: { id: userId, name: 'Updated Name', onboardedAt },
            },
          });
          if (
            current.type !== 'auth_session_found' ||
            before.type !== 'auth_session_found'
          )
            throw new Error('Expected authenticated session');
          expect(current.session.session.id).toBe(before.session.session.id);
        }
      } finally {
        await fixture?.close();
      }
    }
  );
  it.each([false, true])(
    'joins the mapped profile with a conflicting provider-ID account: %s',
    async (conflict) => {
      await database.db.insert(userTable).values(
        makeUserRow({
          id: 'mapped-user',
          email: 'mapped@example.com',
          name: 'Mapped Profile',
        })
      );
      if (conflict)
        await database.db.insert(userTable).values(
          makeUserRow({
            id: 'provider-user',
            email: 'conflict@example.com',
            name: 'Conflicting Profile',
          })
        );
      await database.db.insert(authIdentity).values({
        provider: 'better-auth',
        providerUserId: 'provider-user',
        userId: 'mapped-user',
      });
      const auth = {
        api: {
          getSession: async () => ({
            user: { id: 'provider-user', email: 'provider@example.com' },
            session: {
              id: 'test-session',
              createdAt: new Date(),
              expiresAt: new Date('2099-01-01'),
            },
          }),
        },
      } as unknown as Auth;
      const gateway = new SessionGatewayBetterAuth(
        auth,
        database.db,
        undefined,
        createNoOpTelemetry()
      );
      expect(
        okValue(await gateway.getSession({ headers: new Headers() }))
      ).toMatchObject({
        type: 'auth_session_found',
        session: {
          user: {
            id: 'mapped-user',
            name: 'Mapped Profile',
            email: 'mapped@example.com',
          },
        },
      });
    }
  );
});
