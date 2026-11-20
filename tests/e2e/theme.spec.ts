import { expect, test } from '@tests/e2e/utils';
import { measureTextContrast } from '@tests/support/text-contrast';

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

  for (const theme of ['light', 'dark']) {
    test(`keeps login text readable in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.addInitScript((value) => {
        window.localStorage.setItem('theme', value);
      }, theme);
      await page.goto('/login');
      await expect(page.getByTestId('auth-login-form')).toHaveAttribute(
        'data-hydrated',
        'true'
      );
      await expect(page.locator('html')).toHaveClass(
        new RegExp(`\\b${theme}\\b`)
      );
      const tagline = page.getByText(
        'Drop selected products and materials into architectural images, then compare renders side by side.'
      );
      await expect(tagline).toBeVisible();
      expect(
        (await tagline.evaluate(measureTextContrast)).ratio
      ).toBeGreaterThanOrEqual(4.5);

      const submit = page.getByRole('button', { name: 'Sign in', exact: true });
      expect(
        (await submit.evaluate(measureTextContrast)).ratio
      ).toBeGreaterThanOrEqual(4.5);
      const restingBackground = await submit.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      );
      await submit.hover();
      await expect
        .poll(() =>
          submit.evaluate(
            (element) => getComputedStyle(element).backgroundColor
          )
        )
        .not.toBe(restingBackground);
      await expect
        .poll(() =>
          submit.evaluate((element) => element.getAnimations().length)
        )
        .toBe(0);
      expect(
        (await submit.evaluate(measureTextContrast)).ratio
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});
