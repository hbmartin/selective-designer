import { expect, test } from '@tests/e2e/utils';

test.describe('theme default', () => {
  test.use({
    colorScheme: 'dark',
    storageState: { cookies: [], origins: [] },
  });

  test('opens in light mode even when the OS prefers dark', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.getByTestId('layout-login')).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/\blight\b/);
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  });

  test('keeps an explicit dark choice', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('theme', 'dark');
    });
    await page.goto('/login');
    await expect(page.getByTestId('layout-login')).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  });
});
