import { toAccountName } from '@/modules/account';
import { unwrapParseResult } from '@/modules/kernel/testing';
import { toUserDisplayName } from '@/modules/user';

export const testAccountName = (value: string) =>
  unwrapParseResult(toAccountName(value));

export const testUserDisplayName = (value: string) =>
  unwrapParseResult(toUserDisplayName(value));
