import { relations } from 'drizzle-orm';

import {
  account,
  authIdentity,
  session,
  user,
} from '@/modules/auth/infrastructure/drizzle/schema';

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  identities: many(authIdentity),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const authIdentityRelations = relations(authIdentity, ({ one }) => ({
  user: one(user, {
    fields: [authIdentity.userId],
    references: [user.id],
  }),
}));
