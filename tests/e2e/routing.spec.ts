/* oxlint-disable vitest/no-conditional-in-test -- E2E retry logic handles browser navigation aborts while preserving assertions. */

import { expect, test } from '@tests/e2e/utils';
import { ADMIN_EMAIL, ADMIN_FILE } from '@tests/e2e/utils/constants';

import { DEFAULT_LANGUAGE_KEY } from '@/platform/lib/i18n/constants';

import locales from '@/app/i18n';

const t = locales[DEFAULT_LANGUAGE_KEY];

test.describe('Protected route navigation', () => {
  test('returns to a protected deep link after login with search intact', async ({
    page,
  }) => {
    const encodedEmail = encodeURIComponent(ADMIN_EMAIL);

    await page.goto(`/manager/users?searchTerm=${encodedEmail}`, {
      waitUntil: 'commit',
    });

    await expect(page).toHaveURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('redirect')).toBe(
      `/manager/users?searchTerm=${encodedEmail}`
    );

    await page.login({ email: ADMIN_EMAIL });

    await expect(page).toHaveURL(/\/manager\/users\?searchTerm=/);
    await expect(page.getByTestId('layout-manager')).toBeVisible();
    await expect(page.getByText(ADMIN_EMAIL, { exact: true })).toBeVisible();
    await expect(
      page.getByText(`1 results for "${ADMIN_EMAIL}"`)
    ).toBeVisible();
  });
});

test.describe('Protected route navigation as manager', () => {
  test.use({ storageState: ADMIN_FILE });

  test('opens and refreshes a nested user route from a direct URL', async ({
    page,
  }) => {
    await page.goto(
      `/manager/users?searchTerm=${encodeURIComponent(ADMIN_EMAIL)}`,
      { waitUntil: 'commit' }
    );

    const userLink = page.locator('a[href^="/manager/users/"]').first();
    await expect(userLink).toBeVisible();
    const href = await userLink.getAttribute('href');
    expect(href).toMatch(/^\/manager\/users\/[^/]+\/?$/);

    await expect(async () => {
      try {
        await page.goto(href ?? '/manager/users', { waitUntil: 'commit' });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes('NS_BINDING_ABORTED')
        ) {
          throw error;
        }
      }

      expect(new URL(page.url()).pathname).toMatch(
        /^\/manager\/users\/[^/]+\/?$/
      );
    }).toPass({ timeout: 10_000 });
    const deepLink = new URL(page.url()).pathname;

    await expect(page.getByText(ADMIN_EMAIL).first()).toBeVisible();

    await page.reload({ waitUntil: 'commit' });

    await expect(page).toHaveURL(new RegExp(`${deepLink}/?$`));
    await expect(page.getByTestId('layout-manager')).toBeVisible();
    await expect(page.getByText(ADMIN_EMAIL).first()).toBeVisible();
  });

  test('preserves manager list search params across reloads', async ({
    page,
  }) => {
    const encodedEmail = encodeURIComponent(ADMIN_EMAIL);
    const escapedEncodedEmail = encodedEmail.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );

    await page.goto(`/manager/users?searchTerm=${encodedEmail}`, {
      waitUntil: 'commit',
    });

    await expect(
      page.getByPlaceholder(t.components.searchInput.placeholder)
    ).toHaveValue(ADMIN_EMAIL);
    await expect(page.getByText(ADMIN_EMAIL, { exact: true })).toBeVisible();
    await expect(
      page.getByText(`1 results for "${ADMIN_EMAIL}"`)
    ).toBeVisible();

    await page.reload({ waitUntil: 'commit' });

    await expect(page).toHaveURL(
      new RegExp(`/manager/users\\?searchTerm=${escapedEncodedEmail}$`)
    );
    await expect(
      page.getByPlaceholder(t.components.searchInput.placeholder)
    ).toHaveValue(ADMIN_EMAIL);
    await expect(page.getByText(ADMIN_EMAIL, { exact: true })).toBeVisible();
  });
});
