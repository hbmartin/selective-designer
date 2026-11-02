import type {
  NewSession,
  NewUser,
} from '@/modules/kernel/infrastructure/db/schema';

export const testTimestamps = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-02-01T00:00:00.000Z'),
};

export const makeUserRow = (overrides: Partial<NewUser> = {}): NewUser => ({
  id: 'user-1',
  name: 'Test User',
  email: 'user@example.com',
  emailVerified: true,
  role: 'user',
  ...overrides,
});

export const makeSessionRow = (
  overrides: Partial<NewSession> = {}
): NewSession => ({
  id: 'session-1',
  token: 'token-1',
  userId: 'user-1',
  createdAt: testTimestamps.createdAt,
  updatedAt: testTimestamps.updatedAt,
  expiresAt: testTimestamps.expiresAt,
  ...overrides,
});
