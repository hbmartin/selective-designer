import { createRecoveryTestDatabase } from '@tests/server/recovery-database';
import { makeStrongTestSecret } from '@tests/support/test-secrets';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createAuth } from '@/modules/auth/infrastructure/better-auth/auth';

let database: Awaited<ReturnType<typeof createRecoveryTestDatabase>>;
beforeAll(async () => {
  vi.stubEnv('AUTH_SECRET', makeStrongTestSecret('preview-auth'));
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('VERCEL_BRANCH_URL', 'project-git-feature-team.vercel.app');
  vi.stubEnv('VERCEL_URL', 'project-hash-team.vercel.app');
  vi.stubEnv('AUTH_ALLOWED_HOSTS', 'custom.example');
  database = await createRecoveryTestDatabase();
});
afterAll(async () => {
  await database?.close();
  vi.unstubAllEnvs();
});
it('accepts exact generated hosts and explicit aliases, rejecting wildcard lookalikes', async () => {
  const auth = createAuth({ database: database.db });
  for (const host of [
    'project-git-feature-team.vercel.app',
    'project-hash-team.vercel.app',
    'custom.example',
  ]) {
    const response = await auth.handler(
      new Request(`https://${host}/api/auth/get-session`, { headers: { host } })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  }
  for (const host of [
    'project-git-other-team.vercel.app',
    'project-otherhash-team.vercel.app',
  ]) {
    await expect(
      auth.handler(
        new Request(`https://${host}/api/auth/get-session`, {
          headers: { host },
        })
      )
    ).rejects.toThrow('not in the allowed hosts list');
  }
});
