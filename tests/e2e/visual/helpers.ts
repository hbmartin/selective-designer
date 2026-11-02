import type { Locator, Page } from '@playwright/test';
import { expect } from '@tests/e2e/utils';
import path from 'node:path';

export const chromiumOnlyMessage =
  'Local visual baselines are intentionally kept to Chromium on the developer machine.';

export const desktopViewport = { width: 1280, height: 900 } as const;
export const mobileViewport = { width: 390, height: 844 } as const;

const screenshotStylePath = path.join(import.meta.dirname, 'screenshot.css');

export const screenshot = async (
  page: Page,
  name: string,
  options: { mask?: Locator[] } = {}
) => {
  await expect(page).toHaveScreenshot(name, {
    animations: 'disabled',
    fullPage: true,
    stylePath: screenshotStylePath,
    ...options,
  });
};

export const dynamicUserMetadataMasks = (page: Page) => [
  page.getByText(/ago|Not onboarded/i),
];

export const openManagerUsersSearch = async (page: Page, email: string) => {
  await page.goto(`/manager/users?searchTerm=${encodeURIComponent(email)}`, {
    waitUntil: 'commit',
  });
  await expect(page.getByText(email, { exact: true })).toBeVisible();
};

export const openManagerUserDetail = async (
  page: Page,
  user: { email: string; name: string }
) => {
  await openManagerUsersSearch(page, user.email);
  await page.getByRole('link', { name: user.name, exact: true }).click();
  await expect(page.getByText(user.email, { exact: true })).toBeVisible();
};
