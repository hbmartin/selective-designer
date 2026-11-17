import { ForesightManager } from '@foresightjs/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  NotFoundRoute,
  Outlet,
  RouterContextProvider,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createRef, type ReactNode, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { afterEach, assert, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import buttonLinkFixtures from '@/platform/components/ui/button-link.fixture';
import responsiveButtonLinkFixtures from '@/platform/components/ui/responsive-icon-button-link.fixture';

import { BridgeLink } from '@/platform/router';
import { attachBridgeLinkLocationTracking } from '@/platform/router/bridge-link-location';

async function setupRouter(initialLocation = '/login') {
  const root = createRootRoute();
  const routes = [
    '/login',
    '/logout',
    '/manager',
    '/section',
    '/section/child',
    '/section/logout',
    '/section/safe',
  ].map((path) => createRoute({ getParentRoute: () => root, path }));
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialLocation] }),
    routeTree: root.addChildren(routes),
  });
  attachBridgeLinkLocationTracking(router);
  await router.load();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RouterContextProvider router={router}>
      <RouterProvider router={router} />
      {children}
    </RouterContextProvider>
  );
  return { router, wrapper };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('applies search middleware once after a compiled link stays mounted across navigation', async () => {
  const ref = createRef<HTMLAnchorElement>();
  const root = createRootRoute({
    component: () => (
      <>
        <BridgeLink
          to={'/report' as never}
          search={{ counter: 10 } as never}
          ref={ref}
        >
          Open report
        </BridgeLink>
        <Outlet />
      </>
    ),
  });
  const report = createRoute({
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
  });
  const pages = ['/first', '/second'].map((path) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p>{path}</p>,
    })
  );
  const router = createRouter({
    routeTree: root.addChildren([...pages, report]),
    history: createMemoryHistory({ initialEntries: ['/first'] }),
  });
  attachBridgeLinkLocationTracking(router);
  await router.load();
  const manager = ForesightManager.instance;
  const register = vi.spyOn(manager, 'register');
  const preload = vi.spyOn(router, 'preloadRoute');
  const view = await render(<RouterProvider router={router} />);
  const link = view.getByRole('link', { name: 'Open report' });
  await expect.element(link).toHaveAttribute('href', '/report?counter=11');
  const anchor = ref.current;
  assert(anchor);

  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await act(() => router.navigate({ to: '/second' as never }));
  await expect.element(view.getByText('/second')).toBeVisible();
  expect(ref.current).toBe(anchor);
  await expect.element(link).toHaveAttribute('href', '/report?counter=11');

  const options = register.mock.calls.find(
    ([entry]) => entry.element === anchor
  )?.[0];
  const state = manager.registeredElements.get(anchor);
  assert(options && state);
  options.callback(state);
  const destination = preload.mock.calls.at(-1)?.[0];
  assert(destination);
  expect(router.buildLocation(destination as never).href).toBe(
    '/report?counter=11'
  );
});

it('reports missing client location tracking during BridgeLink setup', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routeTree: createRootRoute(),
  });
  const view = await render(
    <ErrorBoundary fallbackRender={({ error }) => <p>{String(error)}</p>}>
      <RouterContextProvider router={router}>
        <BridgeLink to="/">Home</BridgeLink>
      </RouterContextProvider>
    </ErrorBoundary>
  );
  await expect
    .element(
      view.getByText(
        'Call attachBridgeLinkLocationTracking before using BridgeLink with a client router.',
        { exact: false }
      )
    )
    .toBeVisible();
});

it.each([
  { Fixture: buttonLinkFixtures.Default, name: 'Default' },
  { Fixture: responsiveButtonLinkFixtures.Default, name: 'Add' },
])(
  'attaches the fixture router before rendering the $name link',
  async ({ Fixture, name }) => {
    const view = await render(<Fixture />);
    await expect
      .element(view.getByRole('link', { name }))
      .toHaveAttribute('href', '/');
  }
);

it('preloads the current destination without rendering on Foresight state changes', async () => {
  const { router, wrapper } = await setupRouter();
  const preloadRoute = vi.spyOn(router, 'preloadRoute');
  const manager = ForesightManager.instance;
  const register = vi.spyOn(manager, 'register');
  const ref = createRef<HTMLAnchorElement>();
  const renderLabel = vi.fn(
    ({ isActive }: { isActive: boolean }) => `Router active ${isActive}`
  );
  const view = await render(
    <BridgeLink to="/login" ref={ref}>
      {renderLabel}
    </BridgeLink>,
    { wrapper }
  );
  await expect
    .element(view.getByRole('link', { name: 'Router active true' }))
    .toBeVisible();
  const anchor = ref.current;
  assert(anchor, 'The forwarded ref did not receive the anchor');

  const registration = register.mock.calls.find(
    ([options]) => options.element === anchor
  )?.[0];
  const initialState = manager.registeredElements.get(anchor);
  assert(registration, 'Foresight did not register the anchor');
  assert(initialState, 'Foresight did not expose the registered anchor state');
  expect(initialState).toMatchObject({
    isEnabled: true,
    meta: { to: '/login' },
    reactivateAfter: 60_000,
  });
  registration.callback(initialState);
  expect(preloadRoute).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ to: '/login' })
  );

  const renderCount = renderLabel.mock.calls.length;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await act(async () => {
    manager.updateElementOptions(anchor, { name: 'Updated by manager' });
  });
  expect(manager.registeredElements.get(anchor)?.name).toBe(
    'Updated by manager'
  );
  expect(renderLabel).toHaveBeenCalledTimes(renderCount);

  await view.rerender(
    <BridgeLink to="/manager" ref={ref}>
      Manager
    </BridgeLink>
  );
  expect(ref.current).toBe(anchor);
  const updatedState = manager.registeredElements.get(anchor);
  assert(updatedState, 'Foresight lost the anchor on rerender');
  expect(updatedState.meta).toEqual({ to: '/manager' });
  expect(updatedState.id).toBe(initialState.id);
  registration.callback(updatedState);
  expect(preloadRoute).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ to: '/manager' })
  );

  await view.unmount();
  expect(ref.current).toBeNull();
  expect(manager.registeredElements.has(anchor)).toBe(false);
});

it('keeps a callback ref attached until unmount and calls its cleanup', async () => {
  const { wrapper } = await setupRouter();
  const manager = ForesightManager.instance;
  const cleanup = vi.fn();
  const ref = vi.fn((node: HTMLAnchorElement | null) =>
    node ? cleanup : undefined
  );
  const view = await render(
    <BridgeLink to="/login" ref={ref}>
      Login
    </BridgeLink>,
    { wrapper }
  );
  const anchor = view.container.querySelector('a');
  assert(anchor, 'BridgeLink did not render an anchor');
  expect(ref).toHaveBeenCalledExactlyOnceWith(anchor);
  const initialRegistration = manager.registeredElements.get(anchor);
  assert(initialRegistration, 'Foresight did not register the anchor');

  await view.rerender(
    <BridgeLink to="/manager" ref={ref}>
      Manager
    </BridgeLink>
  );
  expect(ref).toHaveBeenCalledExactlyOnceWith(anchor);
  expect(cleanup).not.toHaveBeenCalled();
  expect(manager.registeredElements.get(anchor)).toMatchObject({
    id: initialRegistration.id,
    meta: { to: '/manager' },
  });

  await view.unmount();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(ref).toHaveBeenCalledExactlyOnceWith(anchor);
  expect(manager.registeredElements.has(anchor)).toBe(false);
});

it('uses the checked relative and masked paths for Foresight and navigation', async () => {
  const { router, wrapper } = await setupRouter('/section/child');
  const manager = ForesightManager.instance;
  const register = vi.spyOn(manager, 'register');
  const preloadRoute = vi.spyOn(router, 'preloadRoute');
  const ref = createRef<HTMLAnchorElement>();
  const view = await render(
    <BridgeLink to={'../safe' as never} ref={ref} mask={{ to: '/login' }}>
      Safe masked link
    </BridgeLink>,
    { wrapper }
  );
  const link = view.getByRole('link', { name: 'Safe masked link' });
  await expect.element(link).toHaveAttribute('href', '/login');

  const anchor = ref.current;
  assert(anchor);
  const options = register.mock.calls.find(
    ([options]) => options.element === anchor
  )?.[0];
  const state = manager.registeredElements.get(anchor);
  assert(options && state);
  options.callback(state);
  expect(preloadRoute).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      to: '/section/safe',
      mask: expect.objectContaining({ to: '/login' }),
    })
  );

  await link.click();
  await vi.waitFor(() =>
    expect(router.state.location.pathname).toBe('/section/safe')
  );
  expect(router.state.location.maskedLocation?.pathname).toBe('/login');
});

it('rechecks a mounted implicit link when a new location changes its destination', async () => {
  const { router, wrapper } = await setupRouter('/section/child');
  const preloadRoute = vi.spyOn(router, 'preloadRoute');
  const onError = vi.fn();
  const view = await render(
    <ErrorBoundary fallback={<p>Blocked destination</p>} onError={onError}>
      <BridgeLink to={'../logout' as never} preload="render">
        Relative link
      </BridgeLink>
    </ErrorBoundary>,
    { wrapper }
  );
  const link = view.getByRole('link', { name: 'Relative link' });
  await expect.element(link).toHaveAttribute('href', '/section/logout');
  await vi.waitFor(() =>
    expect(preloadRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/section/logout',
      })
    )
  );
  preloadRoute.mockClear();

  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await act(() => {
    router.history.push('/section');
  });
  await expect.element(view.getByText('Blocked destination')).toBeVisible();
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining('ConfirmSignOut'),
    }),
    expect.anything()
  );
  expect(preloadRoute).not.toHaveBeenCalled();
});

it('follows native Link through a retained navigation superseded by a departure', async () => {
  const pending = Promise.withResolvers<void>();
  const root = createRootRoute({
    component: () => (
      <>
        <Link to=".." hash preload={false}>
          Native layout
        </Link>
        <BridgeLink to=".." hash preload={false}>
          Bridge layout
        </BridgeLink>
        <Outlet />
      </>
    ),
  });
  const editRef = createRef<HTMLAnchorElement>();
  const profile = createRoute({
    getParentRoute: () => root,
    path: '/people/$id',
    loader: ({ params }) => (params.id === '2' ? pending.promise : undefined),
    component: () => (
      <>
        <Link to=".." hash preload={false}>
          Native profile
        </Link>
        <BridgeLink to=".." hash preload={false}>
          Bridge profile
        </BridgeLink>
        <Link
          from={'/people/$id' as never}
          to={'./edit' as never}
          params
          hash
          preload={false}
        >
          Native edit
        </Link>
        <BridgeLink
          from={'/people/$id' as never}
          to={'./edit' as never}
          params
          hash
          ref={editRef}
        >
          Bridge edit
        </BridgeLink>
      </>
    ),
  });
  const edit = createRoute({
    getParentRoute: () => root,
    path: '/people/$id/edit',
    component: () => <p>Edit ready</p>,
  });
  const other = createRoute({
    getParentRoute: () => root,
    path: '/other',
    loader: () => pending.promise,
  });
  const history = createMemoryHistory({ initialEntries: ['/people/1#old'] });
  const router = createRouter({
    history,
    routeTree: root.addChildren([profile, edit, other]),
    defaultPendingMs: 10_000,
  });
  attachBridgeLinkLocationTracking(router);
  await router.load();

  const manager = ForesightManager.instance;
  const register = vi.spyOn(manager, 'register');
  const preload = vi.spyOn(router, 'preloadRoute');
  const view = await render(
    <RouterContextProvider router={router}>
      <RouterProvider router={router} />
      <Link to=".." hash preload={false}>
        Native outside
      </Link>
      <BridgeLink to=".." hash preload={false}>
        Bridge outside
      </BridgeLink>
    </RouterContextProvider>
  );
  const link = (name: string) => view.getByRole('link', { name });
  try {
    await expect
      .element(link('Bridge edit'))
      .toHaveAttribute('href', '/people/1/edit#old');
    const anchor = editRef.current;
    assert(anchor);
    const registration = register.mock.calls.find(
      ([options]) => options.element === anchor
    )?.[0];
    assert(registration);

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    await act(() => {
      history.push('/people/2#retained');
      expect(router.state.location.pathname).toBe('/people/2');
      history.push('/other#departing');
      expect(router.state.location.pathname).toBe('/other');
    });

    for (const [name, href] of [
      ['profile', '/people#retained'],
      ['edit', '/people/2/edit#retained'],
      ['layout', '/#departing'],
      ['outside', '/#departing'],
    ] as const) {
      await expect
        .element(link(`Native ${name}`))
        .toHaveAttribute('href', href);
      await expect
        .element(link(`Bridge ${name}`))
        .toHaveAttribute('href', href);
    }

    const foresightState = manager.registeredElements.get(anchor);
    assert(foresightState);
    registration.callback(foresightState);
    const preloadOptions = preload.mock.calls.at(-1)?.[0];
    assert(preloadOptions);
    expect(router.buildLocation(preloadOptions as never).href).toBe(
      '/people/2/edit#retained'
    );

    await link('Bridge edit').click();
    await expect.element(view.getByText('Edit ready')).toBeVisible();
    expect(router.state.location.href).toBe('/people/2/edit#retained');
  } finally {
    pending.resolve();
  }
});

it('remounts the last link with the latest retained destination while its route departs', async () => {
  const pending = Promise.withResolvers<void>();
  const root = createRootRoute({ component: Outlet });
  const remountedLink = createRef<HTMLAnchorElement>();
  const attachedHrefs: (string | null)[] = [];
  const linkRef = (anchor: HTMLAnchorElement | null) => {
    remountedLink.current = anchor;
    if (anchor) attachedHrefs.push(anchor.getAttribute('href'));
  };
  const profile = createRoute({
    getParentRoute: () => root,
    path: '/people/$id',
    loader: ({ params }) => (params.id === '2' ? pending.promise : undefined),
    component: function Profile() {
      const [visible, setVisible] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setVisible(!visible)}>
            Toggle link
          </button>
          {visible && (
            <BridgeLink
              from={'/people/$id' as never}
              to={'./edit' as never}
              params
              search
              hash
              state
              mask={
                {
                  to: '/preview/$id',
                  params: true,
                  search: true,
                  hash: true,
                  state: true,
                  unmaskOnReload: true,
                } as never
              }
              ref={linkRef}
            >
              Edit profile
            </BridgeLink>
          )}
        </>
      );
    },
  });
  const edit = createRoute({
    getParentRoute: () => root,
    path: '/people/$id/edit',
    component: () => <p>Edit ready</p>,
  });
  const other = createRoute({
    getParentRoute: () => root,
    path: '/other',
    loader: () => pending.promise,
  });
  const preview = createRoute({
    getParentRoute: () => root,
    path: '/preview/$id',
  });
  const history = createMemoryHistory({
    initialEntries: ['/people/1?tab=initial#initial'],
  });
  const router = createRouter({
    history,
    routeTree: root.addChildren([profile, edit, other, preview]),
    defaultPendingMs: 10_000,
  });
  attachBridgeLinkLocationTracking(router);
  await router.load();

  const manager = ForesightManager.instance;
  const register = vi.spyOn(manager, 'register');
  const preload = vi.spyOn(router, 'preloadRoute');
  const navigate = vi.spyOn(router, 'navigate');
  const view = await render(<RouterProvider router={router} />);
  const toggle = view.getByRole('button', { name: 'Toggle link' });
  const link = view.getByRole('link', { name: 'Edit profile' });

  try {
    await expect
      .element(link)
      .toHaveAttribute('href', '/preview/1?tab=initial#initial');
    await toggle.click();
    await expect.element(link).not.toBeInTheDocument();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    await act(() => {
      history.push('/people/2?tab=retained#retained', { stamp: 'retained' });
      history.push('/other?tab=incoming#incoming', { stamp: 'incoming' });
    });
    expect(router.state.location.pathname).toBe('/other');
    await toggle.click();

    const publicHref = '/preview/2?tab=retained#retained';
    const editHref = '/people/2/edit?tab=retained#retained';
    expect(attachedHrefs).toEqual([
      '/preview/1?tab=initial#initial',
      publicHref,
    ]);
    await expect.element(link).toHaveAttribute('href', publicHref);
    const anchor = remountedLink.current;
    assert(anchor);
    const registration = register.mock.calls.find(
      ([options]) => options.element === anchor
    )?.[0];
    const foresightState = manager.registeredElements.get(anchor);
    assert(registration && foresightState);
    registration.callback(foresightState);
    const options = preload.mock.calls.at(-1)?.[0];
    assert(options);
    expect(options.mask).toMatchObject({ unmaskOnReload: true });
    const destination = {
      href: editHref,
      state: { stamp: 'retained' },
      maskedLocation: { href: publicHref, state: { stamp: 'retained' } },
    };
    expect(router.buildLocation(options as never)).toMatchObject(destination);
    await link.click();
    await expect.element(view.getByText('Edit ready')).toBeVisible();
    const clickOptions = navigate.mock.calls.at(-1)?.[0];
    assert(clickOptions);
    expect(router.buildLocation(clickOptions)).toMatchObject(destination);
    // TanStack reparses the underlying hash separately when it unmasks history.
    expect(router.state.location).toMatchObject({
      pathname: '/people/2/edit',
      search: { tab: 'retained' },
      state: { stamp: 'retained' },
      maskedLocation: { href: publicHref, state: { stamp: 'retained' } },
    });

    await act(() => {
      history.push('/people/3?tab=reentered#reentered');
    });
    await expect
      .element(link)
      .toHaveAttribute('href', '/preview/3?tab=reentered#reentered');
  } finally {
    pending.resolve();
  }
});

it('keeps a legacy not-found route in scope across missing locations', async () => {
  const root = createRootRoute();
  const notFoundRoute = new NotFoundRoute({
    getParentRoute: () => root,
    component: () => (
      <>
        <Link to="/" search hash>
          Native recovery
        </Link>
        <BridgeLink to="/" search hash>
          Bridge recovery
        </BridgeLink>
      </>
    ),
  });
  const history = createMemoryHistory({
    initialEntries: ['/missing-first?tab=first#first'],
  });
  const router = createRouter({ history, routeTree: root, notFoundRoute });
  attachBridgeLinkLocationTracking(router);
  await router.load();
  const view = await render(
    <RouterContextProvider router={router}>
      <RouterProvider router={router} />
      <BridgeLink to="/" search hash>
        Outside recovery
      </BridgeLink>
    </RouterContextProvider>
  );
  const link = (name: string) => view.getByRole('link', { name });
  await expect
    .element(link('Bridge recovery'))
    .toHaveAttribute('href', '/?tab=first#first');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await act(() => {
    history.push('/missing-second?tab=second#second');
  });
  for (const name of [
    'Native recovery',
    'Bridge recovery',
    'Outside recovery',
  ]) {
    await expect
      .element(link(name))
      .toHaveAttribute('href', '/?tab=second#second');
  }
});

it('renders ordinary and external links when URL.canParse is unavailable', async () => {
  const { wrapper } = await setupRouter();
  const canParse = Object.getOwnPropertyDescriptor(URL, 'canParse');
  assert(canParse);
  Reflect.deleteProperty(URL, 'canParse');
  try {
    const view = await render(
      <>
        <BridgeLink to="/manager">Manager</BridgeLink>
        <BridgeLink to={'https://example.test/' as never}>External</BridgeLink>
      </>,
      { wrapper }
    );
    await expect
      .element(view.getByRole('link', { name: 'Manager' }))
      .toHaveAttribute('href', '/manager');
    await expect
      .element(view.getByRole('link', { name: 'External' }))
      .toHaveAttribute('href', 'https://example.test/');
  } finally {
    Object.defineProperty(URL, 'canParse', canParse);
  }
});
