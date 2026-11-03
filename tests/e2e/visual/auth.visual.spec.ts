import { expect, test } from '@tests/e2e/utils';

import {
  chromiumOnlyMessage,
  desktopViewport,
  mobileViewport,
  screenshot,
} from './helpers';

test.describe('Auth visual regression', () => {
  test.describe.configure({ timeout: 60_000 });

  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    chromiumOnlyMessage
  );

  test.describe('desktop', () => {
    test.use({ viewport: desktopViewport });

    test('login page remains visually stable', async ({ page }) => {
      await page.to('/login');
      await expect(page.getByTestId('auth-login-form')).toHaveAttribute(
        'data-hydrated',
        'true'
      );
      await screenshot(page, 'login-page.png');
    });
  });

  test.describe('mobile', () => {
    test.use({ viewport: mobileViewport });

    test('login page remains visually stable on mobile', async ({ page }) => {
      await page.to('/login');
      await expect(page.getByTestId('auth-login-form')).toHaveAttribute(
        'data-hydrated',
        'true'
      );
      await screenshot(page, 'login-page-mobile.png');
    });
  });
});
