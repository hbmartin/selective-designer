/* oxlint-disable vitest/no-conditional-in-test -- The instrumentation mirrors the browser API overload and optional test probe. */

import { expect, test } from '@tests/e2e/utils';
import { ADMIN_FILE } from '@tests/e2e/utils/constants';

import { DEFAULT_LANGUAGE_KEY } from '@/platform/lib/i18n/constants';

import locales from '@/app/i18n';

const t = locales[DEFAULT_LANGUAGE_KEY];

test.describe('Async React search', () => {
  test.use({ storageState: ADMIN_FILE });

  test('manager search typing remains urgent while navigation commits', async ({
    page,
  }) => {
    await page.to('/manager/users');
    const searchInput = page.getByPlaceholder(
      t.components.searchInput.placeholder
    );
    await expect(searchInput.locator('..')).toHaveAttribute(
      'data-hydrated',
      'true'
    );

    await searchInput.fill('Admin User');
    await expect(searchInput).toHaveValue('Admin User');
    await expect(page).toHaveURL(/searchTerm=Admin(?:\+|%20)User/);
  });
});
