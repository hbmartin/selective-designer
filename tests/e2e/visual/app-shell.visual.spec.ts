import { expect, test } from '@tests/e2e/utils';
import { USER_FILE } from '@tests/e2e/utils/constants';

import {
  chromiumOnlyMessage,
  desktopViewport,
  mobileViewport,
  screenshot,
} from './helpers';

test.describe('App shell visual regression', () => {
  test.describe.configure({ timeout: 60_000 });

  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    chromiumOnlyMessage
  );

  test.use({ storageState: USER_FILE });

  for (const theme of ['light', 'dark'] as const) {
    test.describe(theme, () => {
      test.beforeEach(async ({ page }) => {
        await page.addInitScript((value) => {
          window.localStorage.setItem('theme', value);
        }, theme);
      });

      test.describe('desktop', () => {
        test.use({ viewport: desktopViewport });

        test('authenticated app shell remains visually stable', async ({
          page,
        }) => {
          await page.to('/app');
          await expect(page.getByTestId('layout-app')).toBeVisible();
          await expect(
            page.getByRole('link', { name: 'Designs', exact: true })
          ).toBeVisible();
          await expect(page.getByText('No designs yet')).toBeVisible();
          await expect(page.getByText(/access denied/i)).toBeHidden();
          await screenshot(
            page,
            theme === 'dark'
              ? 'authenticated-app-shell-dark.png'
              : 'authenticated-app-shell.png'
          );
        });
      });

      test.describe('mobile', () => {
        test.use({ viewport: mobileViewport });

        test('authenticated app shell remains visually stable on mobile', async ({
          page,
        }) => {
          await page.to('/app');
          await expect(page.getByTestId('layout-app')).toBeVisible();
          await expect(
            page.getByRole('link', { name: 'Designs', exact: true })
          ).toBeVisible();
          await expect(page.getByText('No designs yet')).toBeVisible();
          await expect(page.getByText(/access denied/i)).toBeHidden();
          await screenshot(
            page,
            theme === 'dark'
              ? 'authenticated-app-shell-mobile-dark.png'
              : 'authenticated-app-shell-mobile.png'
          );
        });
      });
    });
  }
});
