import { ButtonLinkFixtureRouter } from '@tests/support/button-link-router';
import { measureTextContrast } from '@tests/support/text-contrast';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { Button } from '@/platform/components/ui/button';
import { ButtonLink } from '@/platform/components/ui/button-link';
import { buttonVariants } from '@/platform/components/ui/button-variants';

const originalTheme = document.documentElement.className;
afterEach(() => {
  document.documentElement.className = originalTheme;
});

it.each(['light', 'dark'])(
  'keeps primary text readable before and during %s hover',
  async (theme) => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
    await render(
      <ButtonLinkFixtureRouter>
        <div
          className="flex flex-col gap-4 bg-background p-6"
          data-testid="contrast-surface"
        >
          <h1>Contrast samples</h1>
          <Button data-testid="primary-button">Create design</Button>
          <ButtonLink to="/" data-testid="primary-link">
            Open design
          </ButtonLink>
          <a
            href="#anchor"
            className="flex w-80 justify-end p-4"
            data-testid="anchor-host"
          >
            <span className={buttonVariants()} data-testid="anchor-content">
              Anchor action
            </span>
          </a>
          <button
            type="button"
            className="flex w-80 justify-end p-4"
            data-testid="button-host"
          >
            <span className={buttonVariants()} data-testid="button-content">
              Button action
            </span>
          </button>
        </div>
      </ButtonLinkFixtureRouter>
    );

    for (const [hostId, contentId] of [
      ['primary-button', 'primary-button'],
      ['primary-link', 'primary-link'],
      ['anchor-host', 'anchor-content'],
      ['button-host', 'button-content'],
    ] as const) {
      await page.getByRole('heading', { name: 'Contrast samples' }).hover();
      const content = page.getByTestId(contentId).element();
      const restingBackground = getComputedStyle(content).backgroundColor;
      expect(measureTextContrast(content).ratio).toBeGreaterThanOrEqual(4.5);

      await page.getByTestId(hostId).hover();
      await expect
        .poll(() => getComputedStyle(content).backgroundColor)
        .not.toBe(restingBackground);
      await expect.poll(() => content.getAnimations().length).toBe(0);
      expect(measureTextContrast(content).ratio).toBeGreaterThanOrEqual(4.5);
    }
  }
);

it('composites a translucent background before measuring text contrast', async () => {
  await render(
    <div style={{ backgroundColor: '#fff' }}>
      <span
        data-testid="translucent-text"
        style={{ backgroundColor: 'rgb(0 0 0 / 50%)', color: '#fff' }}
      >
        Translucent surface
      </span>
    </div>
  );
  const measured = measureTextContrast(
    page.getByTestId('translucent-text').element()
  );
  expect(measured.background).toEqual([127, 127, 127]);
  expect(measured.ratio).toBeCloseTo(4, 1);
});
