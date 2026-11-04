import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';

import {
  createTransactionRunner,
  type Database,
  type DbTransaction,
} from '@/modules/kernel/infrastructure/db/client';

import { account, user } from './schema';
import { operatorPasswordSchema } from '../../domain/password-policy';

const writeCredential = (
  db: Database | DbTransaction,
  userId: string,
  passwordHash: string
) =>
  // Drizzle writes the Better Auth hash to the credential record.
  // nosemgrep: token-or-secret-logging
  db.insert(account).values({
    userId,
    providerId: 'credential',
    accountId: userId,
    password: passwordHash,
  });

export async function addSeedCredentials(
  db: Database,
  userIds: string[],
  password: string
) {
  const passwordHash = await hashPassword(
    operatorPasswordSchema.parse(password)
  );
  await Promise.all(
    userIds.map((userId) =>
      writeCredential(db, userId, passwordHash).onConflictDoNothing()
    )
  );
}

export async function writeOperatorPassword(
  db: Database,
  input: { email: string; password: string } & (
    | { type: 'create'; name: string; role: 'admin' | 'user' }
    | { type: 'reset' }
  )
) {
  const passwordHash = await hashPassword(
    operatorPasswordSchema.parse(input.password)
  );
  return createTransactionRunner(db).run(async (tx) => {
    if (input.type === 'create') {
      const [created] = await tx
        .insert(user)
        .values({
          email: input.email,
          name: input.name,
          role: input.role,
          emailVerified: false,
        })
        .onConflictDoNothing()
        .returning({ id: user.id });
      if (!created) return { type: 'account_exists' } as const;
      await writeCredential(tx, created.id, passwordHash);
      return { type: 'password_set', userId: created.id } as const;
    }

    const [existing] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, input.email))
      .limit(1);
    if (!existing) return { type: 'account_missing' } as const;
    await writeCredential(tx, existing.id, passwordHash).onConflictDoUpdate({
      target: [account.providerId, account.accountId],
      set: { password: passwordHash },
    });
    return { type: 'password_set', userId: existing.id } as const;
  });
}
