import { ButtonLinkFixtureRouter } from '@tests/support/button-link-router';
import { measureTextContrast } from '@tests/support/text-contrast';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/platform/components/ui/alert';
import { Badge } from '@/platform/components/ui/badge';
import { Checkbox } from '@/platform/components/ui/checkbox';
import {
  InputGroup,
  InputGroupInput,
} from '@/platform/components/ui/input-group';
import {
  SidebarProvider,
  SidebarMenuButton,
} from '@/platform/components/ui/sidebar';
import { Button } from '@/platform/components/ui/button';
import { ButtonLink } from '@/platform/components/ui/button-link';
import { buttonVariants } from '@/platform/components/ui/button-variants';

const originalTheme = document.documentElement.className;
afterEach(() => {
  document.documentElement.className = originalTheme;
});

it.each(
  (['light', 'dark'] as const).flatMap((theme) =>
    (['default', 'destructive', 'destructive-secondary'] as const).map(
      (variant) => ({ theme, variant })
    )
  )
)(
  'keeps $variant text readable before and during $theme hover',
  async ({ theme, variant }) => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
    await render(
      <ButtonLinkFixtureRouter>
        <div
          className="flex flex-col gap-4 bg-background p-6"
          data-testid="contrast-surface"
        >
          <h1>Contrast samples</h1>
          <Button variant={variant} data-testid="primary-button">
            Create design
          </Button>
          <ButtonLink variant={variant} to="/" data-testid="primary-link">
            Open design
          </ButtonLink>
          <a
            href="#anchor"
            className="flex w-80 justify-end p-4"
            data-testid="anchor-host"
          >
            <span
              className={buttonVariants({ variant })}
              data-testid="anchor-content"
            >
              Anchor action
            </span>
          </a>
          <button
            type="button"
            className="flex w-80 justify-end p-4"
            data-testid="button-host"
          >
            <span
              className={buttonVariants({ variant })}
              data-testid="button-content"
            >
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

it.each(['light', 'dark'])(
  'keeps linked badges and destructive text readable in %s',
  async (theme) => {
    document.documentElement.className = theme;
    await render(
      <div className="bg-card p-6">
        <h1>Badge samples</h1>
        <Alert variant="destructive">
          <AlertTitle data-testid="alert-title">Failed</AlertTitle>
          <AlertDescription data-testid="alert-description">
            Try again
          </AlertDescription>
        </Alert>
        <Badge render={<a href="#badge" />} data-testid="linked-badge">
          Danger detail
        </Badge>
        <p className="text-destructive-text" data-testid="error-text">
          An error occurred
        </p>
      </div>
    );
    const badge = page.getByTestId('linked-badge');
    expect(measureTextContrast(badge.element()).ratio).toBeGreaterThanOrEqual(
      4.5
    );
    await badge.hover();
    await expect.poll(() => badge.element().getAnimations().length).toBe(0);
    expect(measureTextContrast(badge.element()).ratio).toBeGreaterThanOrEqual(
      4.5
    );
    expect(
      measureTextContrast(page.getByTestId('error-text').element()).ratio
    ).toBeGreaterThanOrEqual(4.5);
    for (const id of ['alert-title', 'alert-description'])
      expect(
        measureTextContrast(page.getByTestId(id).element()).ratio
      ).toBeGreaterThanOrEqual(4.5);
  }
);
it.each(['light', 'dark'])(
  'renders valid sidebar outline shadows in %s',
  async (theme) => {
    document.documentElement.className = theme;
    await render(
      <SidebarProvider>
        <SidebarMenuButton variant="outline" data-testid="outline-menu">
          Menu
        </SidebarMenuButton>
      </SidebarProvider>
    );
    const button = page.getByTestId('outline-menu');
    const rest = getComputedStyle(button.element()).boxShadow;
    expect(rest).not.toBe('none');
    expect(rest).toContain('1px');
    await button.hover();
    expect(getComputedStyle(button.element()).boxShadow).not.toBe('none');
    expect(getComputedStyle(button.element()).boxShadow).toContain('1px');
  }
);
it.each(
  (['light', 'dark'] as const).flatMap((theme) =>
    ['bg-background', 'bg-card', 'bg-canvas', 'bg-accent'].map((surface) => ({
      theme,
      surface,
    }))
  )
)(
  'keeps opaque keyboard focus on $surface in $theme',
  async ({ theme, surface }) => {
    document.documentElement.className = theme;
    await render(
      <div className={`flex flex-col gap-6 p-8 ${surface}`}>
        <button type="button" data-testid="focus-start">
          Start
        </button>
        <Button data-testid="focus-button">Normal</Button>
        <Button
          variant="destructive"
          aria-invalid="true"
          data-testid="focus-invalid"
        >
          Invalid
        </Button>
        <InputGroup data-testid="focus-wrapper">
          <InputGroupInput aria-label="Name" aria-invalid="true" />
        </InputGroup>
        <Checkbox
          defaultChecked
          aria-label="Accept"
          aria-invalid="true"
          data-testid="focus-check"
        />
        <span data-testid="focus-color">Ring sample</span>
      </div>
    );
    const user = userEvent.setup();
    await user.click(page.getByTestId('focus-start'));
    for (const id of [
      'focus-button',
      'focus-invalid',
      'focus-wrapper',
      'focus-check',
    ]) {
      await user.tab();
      const element = page.getByTestId(id).element();
      await expect.poll(() => element.getAnimations().length).toBe(0);
      const style = getComputedStyle(element);
      expect(style.boxShadow).not.toBe('none');
      expect(style.getPropertyValue('--tw-ring-offset-width')).toBe('2px');
      const probe = page.getByTestId('focus-color').element() as HTMLElement;
      probe.style.color = style.getPropertyValue('--tw-ring-color');
      expect(measureTextContrast(probe).ratio).toBeGreaterThanOrEqual(3);
    }
  }
);
it.each([
  { filter: 'brightness(0.8)' },
  { backdropFilter: 'blur(2px)' },
  { mixBlendMode: 'multiply' },
  { backgroundBlendMode: 'multiply' },
  { opacity: 0.5 },
  { backgroundImage: 'linear-gradient(red, blue)' },
] as const)('rejects unsupported effects: %j', async (effect) => {
  await render(
    <div style={{ backgroundColor: 'white', ...effect }}>
      <span data-testid="effect-text">Text</span>
    </div>
  );
  expect(() =>
    measureTextContrast(page.getByTestId('effect-text').element())
  ).toThrow('Contrast measurement requires');
});
it('rejects unsupported canvas colors instead of reusing the previous color', async () => {
  await render(
    <span style={{ backgroundColor: 'white' }} data-testid="bad-color">
      Text
    </span>
  );
  const original = globalThis.getComputedStyle;
  const spy = vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(
    (element) =>
      new Proxy(original(element), {
        get(target, property) {
          return property === 'color'
            ? 'unreadable-color()'
            : Reflect.get(target, property, target);
        },
      })
  );
  try {
    expect(() =>
      measureTextContrast(page.getByTestId('bad-color').element())
    ).toThrow('Unsupported canvas color');
  } finally {
    spy.mockRestore();
  }
});
