import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useMatch,
  useRouter,
} from '@tanstack/react-router';
import {
  ButtonLinkFixtureRouter,
  ButtonLinkRouteChildren,
  ButtonLinkRouterProvider,
} from '@tests/support/button-link-router';
import {
  act,
  createRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { afterEach, assert, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { BackButton } from '@/platform/components/back-button';
import buttonLinkFixtures from '@/platform/components/ui/button-link.fixture';
import { ButtonLink } from '@/platform/components/ui/button-link';
import responsiveButtonLinkFixtures from '@/platform/components/ui/responsive-icon-button-link.fixture';
import { ResponsiveIconButtonLink } from '@/platform/components/ui/responsive-icon-button-link';

async function setupRouter(initialLocation = '/login') {
  const root = createRootRoute({ component: ButtonLinkRouteChildren });
  const router = createRouter({
    defaultPreload: 'intent',
    defaultPreloadDelay: 0,
    history: createMemoryHistory({ initialEntries: [initialLocation] }),
    routeTree: root.addChildren([
      ...[
        '/login',
        '/manager',
        '/manager/users',
        '/manager/users/$id',
        '/manager/users/$id/update',
      ].map((path) =>
        createRoute({ getParentRoute: () => root, path, component: () => null })
      ),
      createRoute({
        getParentRoute: () => root,
        path: '/report',
        search: {
          middlewares: [
            ({ search, next }) => {
              const result = next(search);
              return {
                ...result,
                counter: Number(Reflect.get(result, 'counter')) + 1,
              };
            },
          ],
        },
      }),
    ]),
  });
  await router.load();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ButtonLinkRouterProvider router={router}>
      {children}
    </ButtonLinkRouterProvider>
  );
  return { router, wrapper };
}

async function setupBackNavigation(withHistory = true) {
  const setup = await setupRouter('/manager/users/sample');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  if (withHistory) await act(() => setup.router.navigate({ to: '/manager' }));
  return setup;
}

function observeClick(anchor: HTMLAnchorElement, options: MouseEventInit) {
  let preventedByComponent: boolean | undefined;
  const observe = (event: Event) => {
    preventedByComponent = event.defaultPrevented;
    // Inspect router behavior without allowing the test to open a tab or leave its iframe.
    event.preventDefault();
  };
  document.addEventListener('click', observe, { once: true });
  try {
    anchor.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...options,
      })
    );
  } finally {
    document.removeEventListener('click', observe);
  }
  return preventedByComponent;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('preserves object refs and cleans up a callback ref once after a destination update', async () => {
  const { wrapper } = await setupRouter();
  const objectRef = createRef<HTMLAnchorElement>();
  const cleanup = vi.fn();
  const callbackRef = vi.fn((_anchor: HTMLAnchorElement | null) => cleanup);
  const content = (to: '/login' | '/manager') => (
    <>
      <ButtonLink to={to} ref={callbackRef}>
        Callback link
      </ButtonLink>
      <ButtonLink to={to} ref={objectRef}>
        Object link
      </ButtonLink>
    </>
  );
  const view = await render(content('/login'), { wrapper });
  const anchor = objectRef.current;
  assert(anchor);
  const callbackAnchor = callbackRef.mock.calls[0];
  expect(callbackAnchor).toBeDefined();
  await view.rerender(content('/manager'));
  await expect
    .element(view.getByRole('link', { name: 'Object link' }))
    .toHaveAttribute('href', '/manager');
  expect(objectRef.current).toBe(anchor);
  expect(callbackRef).toHaveBeenCalledTimes(1);
  expect(cleanup).not.toHaveBeenCalled();
  await view.unmount();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(objectRef.current).toBeNull();
});

it('uses current native preload options and respects explicit preload=false and disabled', async () => {
  const { router, wrapper } = await setupRouter();
  const preload = vi.spyOn(router, 'preloadRoute');
  const view = await render(<ButtonLink to="/manager">Manager</ButtonLink>, {
    wrapper,
  });
  const link = view.getByRole('link', { name: 'Manager' });
  await link.hover();
  await expect.poll(() => preload.mock.calls.length).toBeGreaterThan(0);
  expect(
    router.buildLocation(preload.mock.calls.at(-1)![0] as never).pathname
  ).toBe('/manager');
  await link.unhover();
  preload.mockClear();
  await view.rerender(
    <ButtonLink to="/manager/users/$id" params={{ id: 'latest' }}>
      Manager
    </ButtonLink>
  );
  await link.hover();
  await expect.poll(() => preload.mock.calls.length).toBeGreaterThan(0);
  expect(
    router.buildLocation(preload.mock.calls.at(-1)![0] as never).pathname
  ).toBe('/manager/users/latest');
  await link.unhover();
  preload.mockClear();
  await view.rerender(
    <ButtonLink to="/manager" preload={false}>
      Manager
    </ButtonLink>
  );
  await link.hover();
  expect(preload).not.toHaveBeenCalled();
  await view.rerender(
    <ButtonLink to="/manager" preload="intent" disabled>
      Manager
    </ButtonLink>
  );
  await expect.element(link).toHaveAttribute('aria-disabled', 'true');
  await expect.element(link).not.toHaveAttribute('href');
  await expect.element(link).not.toHaveAttribute('disabled');
  await expect.element(link).toHaveAttribute('data-disabled');
  link.element().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  link.element().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  expect(preload).not.toHaveBeenCalled();
});

it.each(['internal', 'untyped external'] as const)(
  'keeps a disabled %s link inert for keyboard and auxiliary activation',
  async (destination) => {
    const { router, wrapper } = await setupRouter();
    const click = vi.fn();
    const auxiliaryClick = vi.fn();
    const parentClick = vi.fn();
    const preload = vi.spyOn(router, 'preloadRoute');
    const ref = createRef<HTMLAnchorElement>();
    const props = {
      disabled: true,
      tabIndex: 0,
      ref,
      onClick: click,
      onAuxClick: auxiliaryClick,
    };
    const link =
      destination === 'internal' ? (
        <ButtonLink to="/manager" {...props}>
          Disabled
        </ButtonLink>
      ) : (
        // @ts-expect-error Defensive coverage for JavaScript callers; external routes are not public API.
        <ButtonLink to="https://example.com" {...props}>
          Disabled
        </ButtonLink>
      );
    const view = await render(
      <div onClick={parentClick}>
        <button>Before</button>
        {link}
        <button>After</button>
      </div>,
      { wrapper }
    );
    const anchor = ref.current;
    assert(anchor);
    expect(anchor.hasAttribute('href')).toBe(false);
    expect(anchor.getAttribute('aria-disabled')).toBe('true');
    expect(anchor.getAttribute('role')).toBe('link');
    expect(anchor.tabIndex).toBe(-1);
    expect(anchor.hasAttribute('data-disabled')).toBe(true);
    const user = userEvent.setup();
    await view.getByRole('button', { name: 'Before' }).click();
    parentClick.mockClear();
    await user.tab();
    await expect
      .element(view.getByRole('button', { name: 'After' }))
      .toHaveFocus();
    anchor.focus();
    await user.keyboard('{Enter}');
    for (const event of [
      new MouseEvent('click', { bubbles: true, cancelable: true }),
      new MouseEvent('auxclick', {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    ]) {
      expect(anchor.dispatchEvent(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }
    anchor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(click).not.toHaveBeenCalled();
    expect(auxiliaryClick).not.toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
    expect(preload).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/login');
  }
);

it('preserves responsive styling and render children at desktop and mobile widths', async () => {
  const { wrapper } = await setupRouter('/manager');
  const initialViewport = {
    width: window.innerWidth,
    height: window.innerHeight,
  };
  try {
    await page.viewport(1100, 800);
    const view = await render(
      <ResponsiveIconButtonLink to="/manager" label="Manager" size="lg">
        {({ isActive }) => <span>{String(isActive)}</span>}
      </ResponsiveIconButtonLink>,
      { wrapper }
    );
    const link = view.getByRole('link', { name: 'true Manager' });
    await expect.element(link).toHaveClass('h-10');
    await expect
      .element(view.getByText('Manager', { exact: true }))
      .not.toHaveClass('sr-only');
    await page.viewport(390, 844);
    await expect.element(link).toHaveClass('size-10');
    await expect
      .element(view.getByText('Manager', { exact: true }))
      .toHaveClass('sr-only');
  } finally {
    await page.viewport(initialViewport.width, initialViewport.height);
  }
});

it('uses BackButton fallback and native history back', async () => {
  const { router, wrapper } = await setupRouter('/manager/users/sample');
  const view = await render(<BackButton>Back</BackButton>, { wrapper });
  const link = view.getByRole('link', { name: 'Back' });
  await expect.element(link).toHaveAttribute('href', '/manager/users');
  await link.click();
  await expect
    .poll(() => router.state.location.pathname)
    .toBe('/manager/users');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await act(() => router.navigate({ to: '/manager' }));
  const back = vi.spyOn(router.history, 'back');
  await link.click();
  expect(back).toHaveBeenCalledExactlyOnceWith({ ignoreBlocker: undefined });
  await expect
    .poll(() => router.state.location.pathname)
    .toBe('/manager/users');
});

it('runs a consumer callback before going back in history', async () => {
  const { router, wrapper } = await setupBackNavigation();
  const order: string[] = [];
  const consumer = vi.fn(() => {
    order.push('consumer');
  });
  const originalBack = router.history.back.bind(router.history);
  const back = vi
    .spyOn(router.history, 'back')
    .mockImplementation((options) => {
      order.push('history');
      return originalBack(options);
    });
  const navigate = vi.spyOn(router, 'navigate');
  const view = await render(<BackButton onClick={consumer}>Back</BackButton>, {
    wrapper,
  });
  await view.getByRole('link', { name: 'Back' }).click();
  expect(order).toEqual(['consumer', 'history']);
  expect(consumer).toHaveBeenCalledTimes(1);
  expect(back).toHaveBeenCalledExactlyOnceWith({ ignoreBlocker: undefined });
  expect(navigate).not.toHaveBeenCalled();
  await expect
    .poll(() => router.state.location.pathname)
    .toBe('/manager/users/sample');
});

it('forwards an explicit blocker bypass to history back', async () => {
  const { router, wrapper } = await setupBackNavigation();
  const back = vi.spyOn(router.history, 'back');
  const navigate = vi.spyOn(router, 'navigate');
  const view = await render(<BackButton ignoreBlocker>Back</BackButton>, {
    wrapper,
  });
  await view.getByRole('link', { name: 'Back' }).click();
  expect(back).toHaveBeenCalledExactlyOnceWith({ ignoreBlocker: true });
  expect(navigate).not.toHaveBeenCalled();
  await expect
    .poll(() => router.state.resolvedLocation?.pathname)
    .toBe('/manager/users/sample');
});

it.each([true, false])(
  'honors document navigation with history available: %s',
  async (withHistory) => {
    const { router, wrapper } = await setupBackNavigation(withHistory);
    const back = vi.spyOn(router.history, 'back');
    // Observe Link's real handler without navigating the browser test iframe.
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(undefined);
    const view = await render(
      <BackButton to="/login" reloadDocument ignoreBlocker replace>
        Back
      </BackButton>,
      { wrapper }
    );
    await expect
      .element(view.getByRole('link', { name: 'Back' }))
      .toHaveAttribute('href', '/login');
    await view.getByRole('link', { name: 'Back' }).click();
    expect(back).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/login',
        reloadDocument: true,
        ignoreBlocker: true,
        replace: true,
      })
    );
  }
);

it('respects cancellation with document navigation and blocker bypass', async () => {
  const { router, wrapper } = await setupBackNavigation();
  const back = vi.spyOn(router.history, 'back');
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(undefined);
  const cancel = vi.fn((event: ReactMouseEvent<HTMLAnchorElement>) =>
    event.preventDefault()
  );
  const view = await render(
    <BackButton to="/login" reloadDocument ignoreBlocker onClick={cancel}>
      Back
    </BackButton>,
    { wrapper }
  );
  await view.getByRole('link', { name: 'Back' }).click();
  expect(cancel).toHaveBeenCalledOnce();
  expect(back).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

it.each([
  { name: 'absent', props: {} },
  { name: 'explicitly undefined', props: { onClick: undefined } },
])('goes back when the consumer callback is $name', async ({ props }) => {
  const { router, wrapper } = await setupBackNavigation();
  const back = vi.spyOn(router.history, 'back');
  const navigate = vi.spyOn(router, 'navigate');
  const view = await render(<BackButton {...props}>Back</BackButton>, {
    wrapper,
  });
  await view.getByRole('link', { name: 'Back' }).click();
  expect(back).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
  await expect
    .poll(() => router.state.location.pathname)
    .toBe('/manager/users/sample');
});

it.each([false, true])(
  'lets the consumer cancel navigation with history available: %s',
  async (withHistory) => {
    const { router, wrapper } = await setupBackNavigation(withHistory);
    const originalLocation = router.state.location;
    const cancel = vi.fn((event: ReactMouseEvent<HTMLAnchorElement>) =>
      event.preventDefault()
    );
    const back = vi.spyOn(router.history, 'back');
    const navigate = vi.spyOn(router, 'navigate');
    const view = await render(<BackButton onClick={cancel}>Back</BackButton>, {
      wrapper,
    });
    await view.getByRole('link', { name: 'Back' }).click();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(router.state.location).toBe(originalLocation);
  }
);

it('runs the consumer before native fallback navigation when no history is available', async () => {
  const { router, wrapper } = await setupBackNavigation(false);
  const order: string[] = [];
  const consumer = vi.fn(() => {
    order.push('consumer');
  });
  const originalNavigate = router.navigate.bind(router);
  const navigate = vi
    .spyOn(router, 'navigate')
    .mockImplementation((options) => {
      order.push('fallback');
      return originalNavigate(options);
    });
  const back = vi.spyOn(router.history, 'back');
  const view = await render(<BackButton onClick={consumer}>Back</BackButton>, {
    wrapper,
  });
  await view.getByRole('link', { name: 'Back' }).click();
  expect(order).toEqual(['consumer', 'fallback']);
  expect(back).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledTimes(1);
  await expect
    .poll(() => router.state.location.pathname)
    .toBe('/manager/users');
});

it.each([
  { name: 'Control', options: { ctrlKey: true }, consumerCalls: 1 },
  { name: 'Meta', options: { metaKey: true }, consumerCalls: 1 },
  { name: 'Shift', options: { shiftKey: true }, consumerCalls: 1 },
  { name: 'Alt', options: { altKey: true }, consumerCalls: 1 },
  { name: 'middle button', options: { button: 1 }, consumerCalls: 1 },
  // React suppresses right-button click events before they reach onClick.
  { name: 'secondary button', options: { button: 2 }, consumerCalls: 0 },
])(
  'leaves $name clicks to the fallback URL without intercepting them',
  async ({ options, consumerCalls }) => {
    const { router, wrapper } = await setupBackNavigation();
    const consumer = vi.fn();
    const back = vi.spyOn(router.history, 'back');
    const navigate = vi.spyOn(router, 'navigate');
    const ref = createRef<HTMLAnchorElement>();
    await render(
      <BackButton ref={ref} onClick={consumer}>
        Back
      </BackButton>,
      { wrapper }
    );
    assert(ref.current);
    expect(ref.current.getAttribute('href')).toBe('/');
    expect(observeClick(ref.current, options)).toBe(false);
    expect(consumer).toHaveBeenCalledTimes(consumerCalls);
    expect(back).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/manager');
  }
);

it.each(['_blank', '_parent', '_top', 'named-window'])(
  'leaves target=%s to native fallback navigation',
  async (target) => {
    const { router, wrapper } = await setupBackNavigation();
    const back = vi.spyOn(router.history, 'back');
    const navigate = vi.spyOn(router, 'navigate');
    const ref = createRef<HTMLAnchorElement>();
    await render(
      <BackButton ref={ref} target={target}>
        Back
      </BackButton>,
      { wrapper }
    );
    assert(ref.current);
    expect(ref.current.getAttribute('target')).toBe(target);
    expect(ref.current.getAttribute('href')).toBe('/');
    expect(observeClick(ref.current, {})).toBe(false);
    expect(back).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/manager');
  }
);

it('retains history back for an explicit _self target', async () => {
  const { router, wrapper } = await setupBackNavigation();
  const back = vi.spyOn(router.history, 'back');
  const view = await render(<BackButton target="_self">Back</BackButton>, {
    wrapper,
  });
  await view.getByRole('link', { name: 'Back' }).click();
  expect(back).toHaveBeenCalledTimes(1);
  await expect
    .poll(() => router.state.location.pathname)
    .toBe('/manager/users/sample');
});

it('uses the rendered target when no target prop is supplied', async () => {
  const { router, wrapper } = await setupBackNavigation();
  const back = vi.spyOn(router.history, 'back');
  const navigate = vi.spyOn(router, 'navigate');
  const ref = createRef<HTMLAnchorElement>();
  await render(<BackButton ref={ref}>Back</BackButton>, { wrapper });
  assert(ref.current);
  ref.current.setAttribute('target', '_blank');
  expect(observeClick(ref.current, {})).toBe(false);
  expect(back).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

it('keeps the explicit target precedence used by native Link', async () => {
  const { router, wrapper } = await setupBackNavigation();
  const back = vi.spyOn(router.history, 'back');
  const view = await render(
    <BackButton
      target="_self"
      onClick={(event) => {
        event.currentTarget.setAttribute('target', '_blank');
      }}
    >
      Back
    </BackButton>,
    { wrapper }
  );
  await view.getByRole('link', { name: 'Back' }).click();
  expect(back).toHaveBeenCalledTimes(1);
  await expect
    .poll(() => router.state.location.pathname)
    .toBe('/manager/users/sample');
});

it('navigates and preloads a safe masked relative destination', async () => {
  const { router, wrapper } = await setupRouter('/manager/users/sample');
  const preload = vi.spyOn(router, 'preloadRoute');
  const view = await render(
    <ButtonLink
      from="/manager/users/$id/"
      to="./update"
      params={{ id: 'sample' }}
      mask={{ to: '/manager' }}
    >
      {({ isActive }) => (isActive ? 'Editing' : 'Edit')}
    </ButtonLink>,
    { wrapper }
  );
  const link = view.getByRole('link', { name: 'Edit' });
  await expect.element(link).toHaveAttribute('href', '/manager');
  await link.hover();
  await expect.poll(() => preload.mock.calls.length).toBeGreaterThan(0);
  const destination = router.buildLocation(
    preload.mock.calls.at(-1)![0] as never
  );
  expect(destination.pathname).toBe('/manager/users/sample/update');
  expect(destination.maskedLocation?.pathname).toBe('/manager');
  await link.click();
  await expect
    .poll(() => router.state.location.pathname)
    .toBe('/manager/users/sample/update');
  expect(router.state.location.maskedLocation?.pathname).toBe('/manager');
  await expect
    .element(view.getByRole('link', { name: 'Editing' }))
    .toBeVisible();
});

it('applies search middleware once per href and preload build across navigation', async () => {
  const { router, wrapper } = await setupRouter();
  const preload = vi.spyOn(router, 'preloadRoute');
  const ref = createRef<HTMLAnchorElement>();
  const view = await render(
    <ButtonLink
      to={'/report' as never}
      search={{ counter: 10 } as never}
      ref={ref}
    >
      Report
    </ButtonLink>,
    { wrapper }
  );
  const anchor = ref.current;
  const link = view.getByRole('link', { name: 'Report' });
  await expect.element(link).toHaveAttribute('href', '/report?counter=11');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await act(() => router.navigate({ to: '/manager' }));
  expect(ref.current).toBe(anchor);
  await expect.element(link).toHaveAttribute('href', '/report?counter=11');
  await link.hover();
  await expect.poll(() => preload.mock.calls.length).toBeGreaterThan(0);
  expect(
    router.buildLocation(preload.mock.calls.at(-1)![0] as never).href
  ).toBe('/report?counter=11');
});

it('keeps the fixture router and anchor while rendering updated children', async () => {
  const routers: unknown[] = [];
  const routeIds: string[] = [];
  function Child({ label }: { label: string }) {
    routers.push(useRouter());
    routeIds.push(useMatch({ strict: false }).routeId);
    return <ButtonLink to="/">{label}</ButtonLink>;
  }
  const content = (label: string) => (
    <ButtonLinkFixtureRouter>
      <Child label={label} />
    </ButtonLinkFixtureRouter>
  );
  const view = await render(content('Before'));
  const anchor = view.getByRole('link', { name: 'Before' }).element();
  await view.rerender(content('After'));
  expect(view.getByRole('link', { name: 'After' }).element()).toBe(anchor);
  expect(routers.length).toBeGreaterThan(1);
  expect(routers.every((router) => router === routers[0])).toBe(true);
  expect(routeIds.every((routeId) => routeId === '__root__')).toBe(true);
});

it.each([buttonLinkFixtures.Default, responsiveButtonLinkFixtures.Default])(
  'renders the native-link fixtures',
  async (Fixture) => {
    const view = await render(<Fixture />);
    await expect.element(view.getByRole('link')).toHaveAttribute('href', '/');
  }
);
