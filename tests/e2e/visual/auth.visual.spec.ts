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

  for (const theme of ['light', 'dark'] as const) {
    test.describe(theme, () => {
      test.beforeEach(async ({ page }) => {
        await page.addInitScript((value) => {
          window.localStorage.setItem('theme', value);
        }, theme);
      });

      test.describe('desktop', () => {
        test.use({ viewport: desktopViewport });

        test('login page remains visually stable', async ({ page }) => {
          await page.to('/login');
          await expect(page.getByTestId('auth-login-form')).toHaveAttribute(
            'data-hydrated',
            'true'
          );
          await screenshot(
            page,
            theme === 'dark' ? 'login-page-dark.png' : 'login-page.png'
          );
        });
      });

      test.describe('mobile', () => {
        test.use({ viewport: mobileViewport });

        test('login page remains visually stable on mobile', async ({
          page,
        }) => {
          await page.to('/login');
          await expect(page.getByTestId('auth-login-form')).toHaveAttribute(
            'data-hydrated',
            'true'
          );
          await screenshot(
            page,
            theme === 'dark'
              ? 'login-page-mobile-dark.png'
              : 'login-page-mobile.png'
          );
        });
      });
    });
  }
});
