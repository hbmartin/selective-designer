import { readFileSync } from 'node:fs';
import { match } from 'ts-pattern';
import { z } from 'zod';

import { getAuth } from '@/composition/auth';
import {
  operatorPasswordSchema,
  writeOperatorPassword,
} from '@/modules/auth/backend';
import { getDefaultDbClient, getRedisConfig } from '@/modules/kernel/backend';

const email = z.string().trim().toLowerCase().pipe(z.email());
const args = z.union([
  z.tuple([
    z.literal('create'),
    email,
    z.string().trim().min(1),
    z.enum(['admin', 'user']).optional(),
  ]),
  z.tuple([z.literal('reset'), email]),
]);

async function main() {
  // run-jiti passes the script filename before the operator arguments.
  const parsed = args.safeParse(process.argv.slice(3));
  if (!parsed.success || process.stdin.isTTY) {
    console.error(
      'Usage: pipe a password to pnpm auth:password create EMAIL NAME [user|admin] or pnpm auth:password reset EMAIL.'
    );
    process.exitCode = 1;
    return;
  }
  const password = operatorPasswordSchema.safeParse(
    readFileSync(0, 'utf8').replace(/\r?\n$/u, '')
  );
  if (!password.success) {
    console.error(
      'Supply a password between 12 and 128 characters on standard input.'
    );
    process.exitCode = 1;
    return;
  }
  const [type, address, name, role] = parsed.data;
  const db = getDefaultDbClient();
  try {
    // Resolve shared session storage before changing an existing credential.
    const authContext =
      type === 'reset' && getRedisConfig()
        ? await getAuth().$context
        : undefined;
    const result = await writeOperatorPassword(
      db,
      type === 'create'
        ? {
            type,
            email: address,
            password: password.data,
            name,
            role: role ?? 'user',
          }
        : { type, email: address, password: password.data }
    );
    await match(result)
      .with({ type: 'account_exists' }, () => {
        throw new Error(
          'Account already exists. Use reset to change its password.'
        );
      })
      .with({ type: 'account_missing' }, () => {
        throw new Error('No account found for that email.');
      })
      .with({ type: 'password_set' }, async ({ userId }) => {
        if (authContext) {
          await authContext.internalAdapter
            .deleteUserSessions(userId)
            .catch(() => {
              throw new Error(
                'Password updated, but session revocation failed. Retry reset to revoke existing sessions.'
              );
            });
        }
        if (type === 'create') console.log('Account created.');
        else if (authContext)
          console.log('Password updated and sessions revoked.');
        else
          console.log(
            'Password updated. Restart running app instances to clear in-memory sessions.'
          );
      })
      .exhaustive();
  } finally {
    await db.$close();
  }
}

try {
  await main();
} catch (error) {
  // Database errors may include SQL parameters. Print only operator-facing messages.
  const message = error instanceof Error ? error.message : '';
  console.error(
    /^(Account already exists|No account found|Password updated, but)/u.test(
      message
    )
      ? message
      : 'Password operation failed. Check database and auth configuration.'
  );
  process.exitCode = 1;
}
