import { expect, test } from '@tests/e2e/utils';
import {
  ADMIN_EMAIL,
  ADMIN_FILE,
  USER_EMAIL,
} from '@tests/e2e/utils/constants';

import {
  chromiumOnlyMessage,
  desktopViewport,
  dynamicUserMetadataMasks,
  mobileViewport,
  openManagerUserDetail,
  openManagerUsersSearch,
  screenshot,
} from './helpers';

const ADMIN_USER = { email: ADMIN_EMAIL, name: 'Admin' } as const;
const REGULAR_USER = { email: USER_EMAIL, name: 'User' } as const;
const EMPTY_SEARCH_TERM = 'visual-empty-search@e2e.local';

test.describe('Manager users visual regression', () => {
  test.describe.configure({ timeout: 60_000 });

  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    chromiumOnlyMessage
  );

  test.use({ storageState: ADMIN_FILE });

  test.describe('desktop', () => {
    test.use({ viewport: desktopViewport });

    test('manager users list remains visually stable', async ({ page }) => {
      await openManagerUsersSearch(page, ADMIN_EMAIL);
      await expect(page.getByText(ADMIN_EMAIL, { exact: true })).toBeVisible();
      await screenshot(page, 'manager-users-list.png', {
        mask: dynamicUserMetadataMasks(page),
      });
    });

    test('manager users empty search remains visually stable', async ({
      page,
    }) => {
      await page.goto(
        `/manager/users?searchTerm=${encodeURIComponent(EMPTY_SEARCH_TERM)}`,
        { waitUntil: 'commit' }
      );
      await expect(page.getByText(EMPTY_SEARCH_TERM)).toBeVisible();
      await screenshot(page, 'manager-users-empty-search.png');
    });

    test('manager user create screen remains visually stable', async ({
      page,
    }) => {
      await page.to('/manager/users');
      await page.getByRole('link', { name: /new user/i }).click();
      await expect(page).toHaveURL(/\/manager\/users\/new$/);
      await expect(page.getByTestId('manager-user-new-form')).toHaveAttribute(
        'data-hydrated',
        'true'
      );
      await screenshot(page, 'manager-user-create.png');
    });

    test('manager user edit screen remains visually stable', async ({
      page,
    }) => {
      await openManagerUserDetail(page, ADMIN_USER);
      await page.getByRole('link', { name: /edit user/i }).click();
      await expect(page).toHaveURL(/\/manager\/users\/[^/]+\/update$/);
      await expect(page.getByLabel('Email')).toHaveValue(ADMIN_EMAIL);
      await screenshot(page, 'manager-user-edit.png');
    });

    test('manager user delete confirmation remains visually stable', async ({
      page,
    }) => {
      await openManagerUserDetail(page, REGULAR_USER);
      const deleteDialog = page.getByRole('dialog', { name: /delete user/i });
      const deleteButton = page.getByRole('button', { name: /^delete$/i });

      await deleteButton.click();
      await expect(async () => {
        await expect(deleteDialog).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 10_000 });

      await screenshot(page, 'manager-user-delete-confirmation.png', {
        mask: dynamicUserMetadataMasks(page),
      });
    });
  });

  test.describe('mobile', () => {
    test.use({ viewport: mobileViewport });

    test('manager users list remains visually stable on mobile', async ({
      page,
    }) => {
      await openManagerUsersSearch(page, ADMIN_EMAIL);
      await expect(page.getByText(ADMIN_EMAIL, { exact: true })).toBeVisible();
      await screenshot(page, 'manager-users-list-mobile.png', {
        mask: dynamicUserMetadataMasks(page),
      });
    });
  });
});
