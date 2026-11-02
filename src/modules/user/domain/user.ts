import { Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import { IdValidationError } from '@/modules/kernel/domain/errors/id-validation-error';
import type {
  EmailAddress,
  ParseResult,
  SessionId,
  UserId,
} from '@/modules/kernel/domain/ids';

import { USER_NAME_MAX_LENGTH } from './user-policy';

export const zUserDisplayNameSchema = z
  .string()
  .trim()
  .max(USER_NAME_MAX_LENGTH)
  .brand<'UserDisplayName'>();

export type UserDisplayName = z.infer<typeof zUserDisplayNameSchema>;

export const zUserDisplayName = () => zUserDisplayNameSchema;

export const toUserDisplayName = (
  name: string
): ParseResult<UserDisplayName> => {
  const result = zUserDisplayNameSchema.safeParse(name);
  if (!result.success) {
    return Result.Error(
      new IdValidationError(
        'UserDisplayName',
        name,
        'UserDisplayName is invalid'
      )
    );
  }
  return Result.Ok(result.data);
};

const emptyUserDisplayNameResult = toUserDisplayName('');
if (emptyUserDisplayNameResult.isError()) {
  throw emptyUserDisplayNameResult.getError();
}
export const emptyUserDisplayName = emptyUserDisplayNameResult.get();

export type UserRole = 'admin' | 'user';

export type User = {
  id: UserId;
  name: UserDisplayName | null;
  email: EmailAddress;
  emailVerified: boolean;
  role: UserRole;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  onboardedAt: Date | null;
};

export type UserSession = {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
};

export type UserListPage = {
  items: User[];
  nextCursor?: UserId;
  total: number;
};

export type UserSessionListPage = {
  items: UserSession[];
  nextCursor?: SessionId;
  total: number;
};

export type UserCreateInput = {
  name?: UserDisplayName | null;
  email: EmailAddress;
  role?: UserRole | null;
};

export type UserUpdateInput = {
  name?: UserDisplayName | null;
  email: EmailAddress;
  role?: UserRole | null;
};

export type UserUpdatePersistenceInput = {
  name?: UserDisplayName;
  email: EmailAddress;
  role?: UserRole;
  emailVerified?: boolean;
};

export type UserUpdateSnapshot = {
  email: EmailAddress;
  role: UserRole;
};

export type SessionRevocationTarget = {
  id: SessionId;
};

export function shouldUnverifyEmail(
  currentEmail: EmailAddress,
  nextEmail: EmailAddress
) {
  return currentEmail !== nextEmail;
}
