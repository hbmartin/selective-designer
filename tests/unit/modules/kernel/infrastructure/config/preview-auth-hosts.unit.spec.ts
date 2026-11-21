import { makeStrongTestSecret } from '@tests/support/test-secrets';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('AUTH_SECRET', makeStrongTestSecret('auth'));
  vi.stubEnv(
    'AUTH_ALLOWED_HOSTS',
    'custom.example,project-git-feature-team.vercel.app'
  );
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('VERCEL_BRANCH_URL', ' PROJECT-GIT-FEATURE-TEAM.vercel.app ');
  vi.stubEnv('VERCEL_URL', 'project-hash-team.vercel.app');
});
afterEach(() => vi.unstubAllEnvs());
async function hosts() {
  const { getBetterAuthConfig } =
    await import('@/modules/kernel/infrastructure/config/auth');
  return getBetterAuthConfig().allowedHosts;
}
it('normalizes both exact Preview hosts and deduplicates explicit aliases', async () => {
  expect(await hosts()).toEqual([
    'custom.example',
    'project-git-feature-team.vercel.app',
    'project-hash-team.vercel.app',
  ]);
});
it.each(['production', 'development', undefined])(
  'does not infer hosts outside Preview: %s',
  async (target) => {
    vi.stubEnv('VERCEL_ENV', target);
    expect(await hosts()).toEqual([
      'custom.example',
      'project-git-feature-team.vercel.app',
    ]);
  }
);
it.each(['', '   ', undefined])(
  'ignores absent metadata: %s',
  async (value) => {
    vi.stubEnv('VERCEL_BRANCH_URL', value);
    vi.stubEnv('VERCEL_URL', value);
    expect(await hosts()).toEqual([
      'custom.example',
      'project-git-feature-team.vercel.app',
    ]);
  }
);
it.each([
  'https://project.vercel.app',
  '*.vercel.app',
  'project.vercel.app:443',
  'project.vercel.app/path',
  'user@project.vercel.app',
  'project.vercel.app?x=1',
  'project.vercel.app#fragment',
])('rejects malformed generated metadata: %s', async (value) => {
  vi.stubEnv('VERCEL_URL', value);
  await expect(hosts()).rejects.toThrow('VERCEL_URL');
});
it('preserves explicitly configured wildcard compatibility', async () => {
  vi.stubEnv('AUTH_ALLOWED_HOSTS', '*.custom.example');
  expect(await hosts()).toContain('*.custom.example');
});
