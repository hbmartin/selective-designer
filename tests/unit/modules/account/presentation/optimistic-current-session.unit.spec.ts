import { describe, expect, it } from 'vitest';

import { projectCurrentSessionName } from '@/modules/account/presentation/optimistic-current-session';
import {
  toEmailAddress,
  toScopeKey,
  toSessionId,
  toUserId,
  unwrapParseResult,
} from '@/modules/kernel/testing';

const currentSession = {
  user: {
    id: unwrapParseResult(toUserId('user-1')),
    email: unwrapParseResult(toEmailAddress('user@example.com')),
    name: 'Before',
    role: 'user' as const,
  },
  session: {
    id: unwrapParseResult(toSessionId('session-1')),
  },
  scope: {
    userId: unwrapParseResult(toUserId('user-1')),
    role: 'user' as const,
  },
  scopeKey: unwrapParseResult(toScopeKey('user:user-1:role:user')),
};

describe('projectCurrentSessionName', () => {
  it('projects a new name without mutating the cached session snapshot', () => {
    const projected = projectCurrentSessionName(currentSession, 'After');

    expect(projected?.user.name).toBe('After');
    expect(currentSession.user.name).toBe('Before');
    expect(projected?.session).toBe(currentSession.session);
  });

  it('preserves anonymous and missing session values', () => {
    expect(projectCurrentSessionName(null, 'After')).toBeNull();
    expect(projectCurrentSessionName(undefined, 'After')).toBeUndefined();
  });
});
