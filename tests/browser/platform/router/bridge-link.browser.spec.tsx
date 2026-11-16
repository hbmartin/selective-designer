import { ForesightManager } from '@foresightjs/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createRef, type ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { afterEach, assert, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { BridgeLink } from '@/platform/router';

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
