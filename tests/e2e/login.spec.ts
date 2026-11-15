import { expect, test } from '@tests/e2e/utils';
import { ADMIN_FILE } from '@tests/e2e/utils/constants';

// The setup project already verifies both roles can sign in from /login.
test.use({ storageState: ADMIN_FILE });

test('redirects an authenticated admin from login to the requested app', async ({
  page,
}) => {
  await page.goto('/login?redirect=%2Fapp', { waitUntil: 'commit' });
  await page.waitForPostAuthRoute('/app');
  await expect(page.getByTestId('layout-app')).toBeVisible();
});
