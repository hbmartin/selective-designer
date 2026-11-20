import { expect, test } from '@tests/e2e/utils';
import { ADMIN_FILE, USER_FILE } from '@tests/e2e/utils/constants';

// The setup project already verifies both roles can sign in from /login.
test.use({ storageState: ADMIN_FILE });

test('redirects an authenticated admin from login to the requested app', async ({
  page,
}) => {
  await page.goto('/login?redirect=%2Fapp', { waitUntil: 'commit' });
  await page.waitForPostAuthRoute('/app');
  await expect(page.getByTestId('layout-app')).toBeVisible();
});

for (const [role, storageState] of [
  ['admin', ADMIN_FILE],
  ['user', USER_FILE],
] as const) {
  test.describe(`${role} default destination`, () => {
    test.use({ storageState });

    for (const entry of ['/', '/login', '/onboarding']) {
      test(`opens designs from ${entry}`, async ({ page }) => {
        await page.goto(entry);
        await expect(page).toHaveURL(/\/app\/designs$/);
        await expect(page.getByTestId('layout-app')).toBeVisible();
      });
    }
  });
}

test.describe('anonymous root visits', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('preserves designs as the destination through login', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\?redirect=%2Fapp%2Fdesigns$/);
  });
});
