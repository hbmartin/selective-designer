import { expect, test } from '@tests/e2e/utils';
import { USER_FILE } from '@tests/e2e/utils/constants';

import { chromiumOnlyMessage, desktopViewport, screenshot } from './helpers';

test.describe('Authorization visual regression', () => {
  test.describe.configure({ timeout: 60_000 });

  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    chromiumOnlyMessage
  );

  test.use({ storageState: USER_FILE, viewport: desktopViewport });

  test('access denied page remains visually stable', async ({ page }) => {
    await page.to('/manager/users');
    await expect(page.getByText('Unauthorized')).toBeVisible();
    await expect(
      page.getByText("You don't have access to this page")
    ).toBeVisible();
    await screenshot(page, 'access-denied-page.png');
  });
});
