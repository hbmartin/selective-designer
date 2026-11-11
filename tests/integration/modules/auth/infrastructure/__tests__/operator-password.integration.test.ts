import { createRecoveryTestDatabase } from '@tests/server/recovery-database';
import { okValue } from '@tests/support/result';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createNoOpTelemetry } from '@/platform/telemetry';
import { UpstashSecondaryStore } from '@/modules/auth/infrastructure/secondary-store/upstash-secondary-store';
import { SessionGatewayBetterAuth } from '@/modules/auth/infrastructure/better-auth/session-gateway-better-auth';
import { user } from '@/modules/auth/infrastructure/better-auth/schema';
import {
  createAuth,
  type Auth,
} from '@/modules/auth/infrastructure/better-auth/auth';
import { writeOperatorPassword } from '@/modules/auth/infrastructure/better-auth/password-credentials';
import { createUserRepository } from '@/modules/auth/infrastructure/drizzle/user-repository-drizzle';
import { toEmailAddress, toUserId } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import { envClient } from '@/platform/env/client';

const email = 'operator-test@example.com';
const generatedPassword = () => randomBytes(24).toString('hex');
const authHeaders = () =>
  new Headers({ host: new URL(envClient.VITE_BASE_URL).host });

async function signInCookie(auth: Auth, password: string) {
  const response = await auth.api.signInEmail({
    asResponse: true,
    headers: authHeaders(),
    body: { email, password },
  });
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .find((entry) => entry.startsWith('better-auth.session_token='))
    ?.split(';')[0];
  if (!cookie) throw new Error('Expected signed session cookie');
  const headers = authHeaders();
  headers.set('cookie', cookie);
  return headers;
}

async function createUpstashRestFixture() {
  const values = new Map<string, string>();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const [command, key, value, evalKey] = JSON.parse(
      Buffer.concat(chunks).toString()
    );
    let result: string | number | null = null;
    switch (command) {
      case 'GET':
        result = values.get(key) ?? null;
        break;
      case 'SET':
        values.set(key, value);
        result = 'OK';
        break;
      case 'DEL':
        result = Number(values.delete(key));
        break;
      case 'EVAL':
        result = Number(values.get(evalKey) ?? '0') + 1;
        values.set(evalKey, String(result));
        break;
      default:
        response.writeHead(400).end();
        return;
    }
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('REST fixture failed to bind');
  return {
    store: new UpstashSecondaryStore({
      config: {
        restUrl: `http://127.0.0.1:${address.port}`,
        restToken: randomBytes(16).toString('hex'),
      },
      telemetry: createNoOpTelemetry(),
    }),
    values,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('operator passwords', () => {
  let database: Awaited<ReturnType<typeof createRecoveryTestDatabase>>;

  beforeAll(async () => {
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    database = await createRecoveryTestDatabase();
  });

  beforeEach(async () => {
    await database.reset();
  });

  afterAll(async () => {
    try {
      await database?.reset();
    } finally {
      vi.unstubAllEnvs();
      await database?.close();
    }
  });

  it('signs in without verification after an operator changes the email or resets the password', async () => {
    const auth = createAuth({ database: database.db });
    const users = createUserRepository({ db: database.db });
    const email = 'invited@example.com';
    const nextEmail = 'new-invited@example.com';
    const password = randomBytes(24).toString('hex');
    const newPassword = randomBytes(24).toString('hex');
    const signIn = (email: string, password: string) =>
      auth.api.signInEmail({
        headers: new Headers({ host: new URL(envClient.VITE_BASE_URL).host }),
        body: { email, password },
      });

    const created = await writeOperatorPassword(database.db, {
      type: 'create',
      email,
      name: 'Invited user',
      role: 'user',
      password,
    });
    expect(created.type).toBe('password_set');
    if (created.type !== 'password_set') throw new Error('Provisioning failed');
    const id = unwrapParseResult(toUserId(created.userId));
    expect((await signIn(email, password)).user).toMatchObject({
      id,
      email,
      emailVerified: false,
    });

    expect(
      okValue(
        await users.update(id, {
          email: unwrapParseResult(toEmailAddress(nextEmail)),
        })
      ).type
    ).toBe('user_updated');
    expect((await signIn(nextEmail, password)).user).toMatchObject({
      id,
      email: nextEmail,
      emailVerified: false,
    });
    await expect(signIn(email, password)).rejects.toMatchObject({
      status: 'UNAUTHORIZED',
    });

    expect(
      await writeOperatorPassword(database.db, {
        type: 'reset',
        email: nextEmail,
        password: newPassword,
      })
    ).toEqual({ type: 'password_set', userId: id });
    expect((await signIn(nextEmail, newPassword)).user.id).toBe(id);
    await expect(signIn(nextEmail, password)).rejects.toMatchObject({
      status: 'UNAUTHORIZED',
    });
  });

  const provision = async (password: string) =>
    writeOperatorPassword(database.db, {
      type: 'create',
      email,
      name: 'Recovery test user',
      role: 'admin',
      password,
    });

  const reset = (password: string) =>
    writeOperatorPassword(database.db, { type: 'reset', email, password });

  const version = async () => {
    const [row] = await database.db
      .select({ version: user.credentialVersion })
      .from(user)
      .where(eq(user.email, email));
    return row?.version;
  };

  it('invalidates sessions in independent instances after the fixed cache window', async () => {
    const oldPassword = generatedPassword();
    await provision(oldPassword);
    let now = 1_000;
    const createInstance = () =>
      createAuth({
        database: database.db,
        credentialVersionClock: () => now,
      });
    const authA = createInstance();
    const authB = createInstance();
    const cookiesA = await signInCookie(authA, oldPassword);
    const cookiesB = await signInCookie(authB, oldPassword);
    const sessionGateway = new SessionGatewayBetterAuth(
      authA,
      database.db,
      undefined,
      createNoOpTelemetry()
    );
    expect(
      okValue(await sessionGateway.getSession({ headers: cookiesA })).type
    ).toBe('auth_session_found');
    expect(await authB.api.getSession({ headers: cookiesB })).not.toBeNull();

    const newPassword = generatedPassword();
    await reset(newPassword);
    now += 29_999;
    expect(await authB.api.getSession({ headers: cookiesB })).not.toBeNull();
    now++;
    expect(
      okValue(await sessionGateway.getSession({ headers: cookiesA })).type
    ).toBe('auth_session_missing');
    expect(await authB.api.getSession({ headers: cookiesB })).toBeNull();
    await expect(
      authB.api.listSessions({ headers: cookiesB })
    ).rejects.toMatchObject({ status: 'UNAUTHORIZED' });
    const denied = await authA.handler(
      new Request(new URL('/api/auth/update-user', envClient.VITE_BASE_URL), {
        method: 'POST',
        headers: {
          cookie: cookiesA.get('cookie')!,
          origin: new URL(envClient.VITE_BASE_URL).origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Must not change' }),
      })
    );
    expect(denied.status).toBe(401);
    expect(
      await authB.api.getSession({
        headers: await signInCookie(authB, newPassword),
      })
    ).not.toBeNull();
  });

  it('rejects stale Upstash sessions without removing records and accepts the new version immediately', async () => {
    const fixture = await createUpstashRestFixture();
    try {
      const oldPassword = generatedPassword();
      await provision(oldPassword);
      const auth = createAuth({
        database: database.db,
        secondaryStore: fixture.store,
      });
      const oldCookie = await signInCookie(auth, oldPassword);
      expect(await auth.api.getSession({ headers: oldCookie })).not.toBeNull();
      const newPassword = generatedPassword();
      await reset(newPassword);
      const stale = [...fixture.values].find(
        ([, value]) =>
          value.includes('"credentialVersion":0') &&
          value.startsWith('{"session":')
      );
      expect(stale).toBeDefined();
      const newCookie = await signInCookie(auth, newPassword);
      const fresh = await auth.api.getSession({ headers: newCookie });
      expect(fresh?.session.credentialVersion).toBe(1);
      expect(await auth.api.getSession({ headers: oldCookie })).toBeNull();
      expect(fixture.values.get(stale![0])).toBe(stale![1]);
      const current = [...fixture.values].find(
        ([, value]) =>
          value.startsWith('{"session":') &&
          value.includes('"credentialVersion":1')
      );
      if (!current) throw new Error('Expected a current session record');
      const envelope = JSON.parse(current[1]);
      envelope.session.expiresAt = new Date(Date.now() + 60_000).toISOString();
      fixture.values.set(current[0], JSON.stringify(envelope));
      const refreshed = await auth.api.getSession({ headers: newCookie });
      expect(refreshed?.session.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 60_000
      );
      expect(refreshed?.session.credentialVersion).toBe(1);
      await expect(
        auth.api.updateSession({
          headers: newCookie,
          body: { credentialVersion: 3 },
        })
      ).rejects.toMatchObject({ status: 'BAD_REQUEST' });
      expect(
        (await auth.api.getSession({ headers: newCookie }))?.session
          .credentialVersion
      ).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it('cannot stamp a new version onto a login that verified the old credential', async () => {
    const oldPassword = generatedPassword();
    await provision(oldPassword);
    const auth = createAuth({ database: database.db });
    const { password } = await auth.$context;
    const verify = password.verify;
    const verified = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(password, 'verify').mockImplementationOnce(async (input) => {
      const result = await verify(input);
      verified.resolve();
      await release.promise;
      return result;
    });
    const signIn = signInCookie(auth, oldPassword);
    // If sign-in fails before verifying, surface the failure without waiting indefinitely.
    await Promise.race([verified.promise, signIn]);
    try {
      await reset(generatedPassword());
    } finally {
      release.resolve();
    }
    expect(await version()).toBe(1);
    expect(await auth.api.getSession({ headers: await signIn })).toBeNull();
  });

  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'does not advance the credential version when the password transaction rolls back',
    async () => {
      const oldPassword = generatedPassword();
      await provision(oldPassword);
      await database.db.$client.query(`
      CREATE FUNCTION reject_test_credential_change() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'test credential write failure'; END; $$;
    `);
      await database.db.$client.query(`
      CREATE TRIGGER reject_test_credential_change BEFORE UPDATE ON account
      FOR EACH ROW EXECUTE FUNCTION reject_test_credential_change();
    `);
      try {
        await expect(reset(generatedPassword())).rejects.toThrow();
        expect(await version()).toBe(0);
      } finally {
        await database.db.$client.query(
          'DROP TRIGGER reject_test_credential_change ON account'
        );
        await database.db.$client.query(
          'DROP FUNCTION reject_test_credential_change()'
        );
      }
      expect(
        await signInCookie(createAuth({ database: database.db }), oldPassword)
      ).toBeInstanceOf(Headers);
    }
  );

  it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
    'does not lose an increment on concurrent native PostgreSQL resets',
    async () => {
      await provision(generatedPassword());
      await Promise.all([
        reset(generatedPassword()),
        reset(generatedPassword()),
      ]);
      expect(await version()).toBe(2);
    }
  );

  it('keeps password writes and impersonation unavailable through Better Auth', async () => {
    const password = generatedPassword();
    const created = await provision(password);
    if (created.type !== 'password_set') throw new Error('Provisioning failed');
    const auth = createAuth({ database: database.db });
    const headers = await signInCookie(auth, password);
    const newPassword = generatedPassword();
    await expect(
      auth.api.changePassword({
        headers,
        body: { currentPassword: password, newPassword },
      })
    ).rejects.toMatchObject({ status: 'NOT_FOUND' });
    await expect(
      auth.api.setPassword({ headers, body: { newPassword } })
    ).rejects.toMatchObject({ status: 'NOT_FOUND' });
    await expect(
      auth.api.impersonateUser({ headers, body: { userId: created.userId } })
    ).rejects.toMatchObject({ status: 'NOT_FOUND' });
    await expect(
      auth.api.adminUpdateUser({
        headers,
        body: { userId: created.userId, data: { credentialVersion: 99 } },
      })
    ).rejects.toMatchObject({ status: 'BAD_REQUEST' });
    expect(await version()).toBe(0);
  });
});
