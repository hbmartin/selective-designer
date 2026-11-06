export * from './common';
export * from './provider-call';
export * from './relations';
export * from './upload-intent';
export * from '@/modules/auth/infrastructure/drizzle/schema';
export * from '@/modules/design/infrastructure/drizzle/schema';
export * from '@/modules/email/infrastructure/drizzle/schema';
export * from '@/modules/moodboard/infrastructure/drizzle/schema';
export * from '@/modules/rendering/infrastructure/drizzle/schema';
export * from '@/modules/segmentation/infrastructure/drizzle/schema';

import {
  account,
  authIdentity,
  session,
  user,
  verification,
} from '@/modules/auth/infrastructure/drizzle/schema';
import { emailStatus } from '@/modules/email/infrastructure/drizzle/schema';

import { providerCall } from './provider-call';
import { uploadIntent } from './upload-intent';

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
export type UploadIntentRow = typeof uploadIntent.$inferSelect;
export type NewUploadIntentRow = typeof uploadIntent.$inferInsert;
export type ProviderCallRow = typeof providerCall.$inferSelect;
export type NewProviderCallRow = typeof providerCall.$inferInsert;

export * from './provider-call-receipt';
