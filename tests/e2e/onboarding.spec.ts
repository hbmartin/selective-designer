import { expect, test } from '@tests/e2e/utils';
import { makeTestDatabaseUrl } from '@tests/server/test-database-url';
import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';

import { writeOperatorPassword } from '@/modules/auth/backend';
import { createDbClient } from '@/modules/kernel/infrastructure/db/client';
import { user as userTable } from '@/modules/kernel/infrastructure/db/schema';

test.use({ storageState: { cookies: [], origins: [] } });

for (const role of ['admin', 'user'] as const) {
  test(`completes ${role} onboarding within the original login session`, async ({
    page,
  }, testInfo) => {
    const baseURL = new URL(String(testInfo.project.use.baseURL));
    if (!['localhost', '127.0.0.1', '[::1]'].includes(baseURL.hostname)) {
      throw new Error('Onboarding E2E accounts require a loopback app.');
    }
    await page.setViewportSize(
      role === 'admin'
        ? { width: 1440, height: 900 }
        : { width: 390, height: 844 }
    );
    const db = createDbClient({
      driver: 'node-pg',
      url: makeTestDatabaseUrl({
        host: '127.0.0.1',
        port: 54329,
        databaseName: 'postgres',
        credentialLabel: 'onboarding-e2e',
      }),
    });
    const email = `onboarding-${randomUUID()}@e2e.local`;
    const password = randomBytes(24).toString('base64url');
    try {
      const created = await writeOperatorPassword(db, {
        type: 'create',
        email,
        password,
        name: 'New User',
        role,
      });
      expect(created.type).toBe('password_set');
      await page.goto('/');
      await expect(page.getByTestId('auth-login-form')).toHaveAttribute(
        'data-hydrated',
        'true'
      );
      await page.setExtraHTTPHeaders({
        'x-forwarded-for': role === 'admin' ? '127.0.0.2' : '127.0.0.3',
      });
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page).toHaveURL(/\/onboarding\?redirect=%2Fapp%2Fdesigns$/);
      const originalSession = (await page.context().cookies()).find((cookie) =>
        cookie.name.includes('session_token')
      );
      expect(originalSession).toBeDefined();
      await page.screenshot({
        path: testInfo.outputPath(`onboarding-${role}.png`),
        fullPage: true,
      });
      await page.getByLabel('What is your name?').fill('Completed User');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page).toHaveURL(/\/app\/designs$/);
      await expect(page.getByTestId('layout-app')).toBeVisible();
      const currentSession = (await page.context().cookies()).find(
        (cookie) => cookie.name === originalSession?.name
      );
      expect(currentSession?.value).toBe(originalSession?.value);
      await page.reload();
      await expect(page).toHaveURL(/\/app\/designs$/);
      await page.screenshot({
        path: testInfo.outputPath(`designs-${role}.png`),
        fullPage: true,
      });
    } finally {
      await db.delete(userTable).where(eq(userTable.email, email));
      await db.$close();
    }
  });
}
