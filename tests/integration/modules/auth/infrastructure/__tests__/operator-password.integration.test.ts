import { createPgliteTestDatabase } from '@tests/server/pglite';
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

import { createAuth } from '@/modules/auth/infrastructure/better-auth/auth';
import { writeOperatorPassword } from '@/modules/auth/infrastructure/better-auth/password-credentials';
import { createUserRepository } from '@/modules/auth/infrastructure/drizzle/user-repository-drizzle';
import { toEmailAddress, toUserId } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import { envClient } from '@/platform/env/client';

describe('operator passwords', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;

  beforeAll(async () => {
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    database = await createPgliteTestDatabase();
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
});
