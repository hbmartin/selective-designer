import type {
  EmailAddress,
  SessionId,
  UserId,
} from '@/modules/kernel/domain/ids';

import type { Role } from './permissions';

export type AuthenticatedUser = {
  id: UserId;
  email: EmailAddress;
  name?: string | null;
  image?: string | null;
  emailVerified?: boolean;
  role: Role;
  onboardedAt?: Date | string | null;
};

export type AuthenticatedSession = {
  id: SessionId;
  userId?: UserId;
  expiresAt?: Date | string;
  /**
   * Original sign-in time, carried from the provider session. Used by the
   * freshness policy for step-up re-authentication on destructive actions.
   */
  createdAt?: Date | string;
};

export type AuthSession = {
  user: AuthenticatedUser;
  session: AuthenticatedSession;
};
