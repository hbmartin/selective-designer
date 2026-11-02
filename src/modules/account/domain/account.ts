import { Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import {
  IdValidationError,
  type ParseResult,
  type UserId,
} from '@/modules/kernel';

import { ACCOUNT_NAME_MAX_LENGTH } from './account-policy';

export const zAccountNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(ACCOUNT_NAME_MAX_LENGTH)
  .brand<'AccountName'>();

export type AccountName = z.infer<typeof zAccountNameSchema>;

export const zAccountName = () => zAccountNameSchema;

export const toAccountName = (name: string): ParseResult<AccountName> => {
  const result = zAccountNameSchema.safeParse(name);
  if (!result.success) {
    return Result.Error(
      new IdValidationError(
        'AccountName',
        '<redacted>',
        'AccountName is invalid'
      )
    );
  }
  return Result.Ok(result.data);
};

export type AccountProfileUpdate = {
  name: AccountName;
};

export type AccountOnboardingUpdate = {
  name: AccountName;
  onboardedAt: Date;
};

export type AccountUpdateResult = {
  id: UserId;
};

export function normalizeAccountName(name: AccountName) {
  return name;
}
