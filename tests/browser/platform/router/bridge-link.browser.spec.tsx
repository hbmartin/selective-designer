import { ForesightManager } from '@foresightjs/react';
import { act, createRef, type ReactNode, type Ref } from 'react';
import { afterEach, assert, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

const router = vi.hoisted(() => ({
  preloadRoute: vi.fn(async () => []),
  renderLink: vi.fn(),
}));

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useRouter: () => router,
  Link: ({
    children,
    ref,
    to,
  }: {
    children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
    ref?: Ref<HTMLAnchorElement>;
    to: string;
  }) => {
    router.renderLink();
    return (
      <a href={to} ref={ref}>
        {typeof children === 'function'
          ? children({ isActive: true })
          : children}
      </a>
    );
  },
}));

import { BridgeLink } from '@/platform/router';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('preloads the current destination without rendering on Foresight state changes', async () => {
  const manager = ForesightManager.instance;
  const register = vi.spyOn(manager, 'register');
  const ref = createRef<HTMLAnchorElement>();
  const view = await render(
    <BridgeLink to="/login" ref={ref}>
      {({ isActive }) => `Router active ${isActive}`}
    </BridgeLink>
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
  expect(router.preloadRoute).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ to: '/login' })
  );

  const renderCount = router.renderLink.mock.calls.length;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await act(async () => {
    manager.updateElementOptions(anchor, { name: 'Updated by manager' });
  });
  expect(manager.registeredElements.get(anchor)?.name).toBe(
    'Updated by manager'
  );
  expect(router.renderLink).toHaveBeenCalledTimes(renderCount);

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
  expect(router.preloadRoute).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ to: '/manager' })
  );

  await view.unmount();
  expect(ref.current).toBeNull();
  expect(manager.registeredElements.has(anchor)).toBe(false);
});

it('keeps a callback ref attached until unmount and calls its cleanup', async () => {
  const manager = ForesightManager.instance;
  const cleanup = vi.fn();
  const ref = vi.fn((node: HTMLAnchorElement | null) =>
    node ? cleanup : undefined
  );
  const view = await render(
    <BridgeLink to="/login" ref={ref}>
      Login
    </BridgeLink>
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
