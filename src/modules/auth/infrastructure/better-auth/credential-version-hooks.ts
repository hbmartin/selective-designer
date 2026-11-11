import { APIError, createAuthMiddleware } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@/modules/kernel/infrastructure/db/client';

import { isOperatorOnlyAuthPath } from './auth-http-exposure';
import { user } from './schema';

export const credentialVersionField = {
  type: 'number',
  input: false,
  defaultValue: 0,
} as const;

const snapshotSchema = z.object({
  id: z.string(),
  credentialVersion: z.number().int().nonnegative(),
});

const protectVersion = (data: object) => {
  if ('credentialVersion' in data) {
    throw new APIError('BAD_REQUEST', {
      message: 'Credential version is server-managed',
    });
  }
  return Promise.resolve();
};

export function createCredentialVersionHooks(database: Database) {
  return {
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Better Call supplies '/' to middleware for pathless server APIs.
        if (ctx.path === '/' || isOperatorOnlyAuthPath(ctx.path)) {
          throw new APIError('NOT_FOUND');
        }
        if (ctx.path !== '/sign-in/email') return;
        const email: unknown = ctx.body?.email;
        if (typeof email !== 'string') return;
        // Capture before the SDK looks up and verifies the password. A reset
        // during verification must never upgrade that login to the new version.
        const [credentialSnapshot] = await database
          .select({ id: user.id, credentialVersion: user.credentialVersion })
          .from(user)
          .where(eq(user.email, email.toLowerCase()))
          .limit(1);
        if (!credentialSnapshot) return;
        return { context: { context: { credentialSnapshot } } };
      }),
    },
    databaseHooks: {
      user: { update: { before: protectVersion } },
      session: {
        update: { before: protectVersion },
        create: {
          before: (
            session: { userId: string },
            endpoint: { context: object } | null
          ) => {
            const context = endpoint?.context;
            const snapshot = snapshotSchema.safeParse(
              context && 'credentialSnapshot' in context
                ? context.credentialSnapshot
                : undefined
            );
            if (!snapshot.success || snapshot.data.id !== session.userId)
              return Promise.resolve(false as const);
            return Promise.resolve({
              data: { credentialVersion: snapshot.data.credentialVersion },
            });
          },
        },
      },
    },
  };
}
