import type { UserId } from '@/modules/kernel';

import type { UserRole } from './user';

/** Role assigned to a new account when none is explicitly requested. */
export const DEFAULT_USER_ROLE: UserRole = 'user';

/**
 * Maximum stored length of a user display name. Shared by the presentation form
 * schema and the server-side transport validator so the bound is enforced at
 * both tiers (A04 "plausibility checks at each tier"). (CWE-1284 / CWE-770.)
 */
export const USER_NAME_MAX_LENGTH = 200;

/**
 * True when `role` is an explicitly-requested, non-default (privileged) role.
 * Assigning such a role is a privilege assignment that must be gated behind the
 * dedicated `user:set-role` permission, both on create and update.
 */
export function assignsPrivilegedRole(
  role: UserRole | null | undefined
): boolean {
  return role !== undefined && role !== null && role !== DEFAULT_USER_ROLE;
}

export function canChangeRole(input: {
  currentUserId: UserId;
  userId: UserId;
  nextRole?: UserRole;
  currentRole: UserRole;
}) {
  return (
    input.currentUserId !== input.userId &&
    input.nextRole !== undefined &&
    input.nextRole !== input.currentRole
  );
}

export function isSelfTarget(currentUserId: UserId, userId: UserId) {
  return currentUserId === userId;
}
