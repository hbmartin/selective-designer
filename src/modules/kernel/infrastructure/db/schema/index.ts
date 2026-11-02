export * from './common';
export * from './relations';
export * from '@/modules/auth/infrastructure/drizzle/schema';
export * from '@/modules/email/infrastructure/drizzle/schema';

import {
  account,
  authIdentity,
  session,
  user,
  verification,
} from '@/modules/auth/infrastructure/drizzle/schema';
import { emailStatus } from '@/modules/email/infrastructure/drizzle/schema';

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;
export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;
export type AuthIdentity = typeof authIdentity.$inferSelect;
export type NewAuthIdentity = typeof authIdentity.$inferInsert;
export type Verification = typeof verification.$inferSelect;
export type NewVerification = typeof verification.$inferInsert;
export type EmailStatus = typeof emailStatus.$inferSelect;
export type NewEmailStatus = typeof emailStatus.$inferInsert;
