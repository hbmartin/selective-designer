import { type ComponentType, createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assert, beforeEach, expect, it, vi } from 'vitest';

import { BridgeLink } from '@/platform/router';

type LinkProps = {
  children: string;
  disabled?: boolean;
  preload?: false | 'intent';
  href?: string;
  to?: string;
  unsafeRelative?: 'path';
};

type ForesightRegistration = {
  callback: () => void;
  enabled: boolean;
};

const mocks = vi.hoisted(() => ({
  links: vi.fn<(props: LinkProps) => ReactNode>((props) => props.children),
  register: vi.fn<(options: ForesightRegistration) => void>(),
  preloadRoute: vi.fn(async () => []),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: mocks.links,
  useRouter: () => ({ preloadRoute: mocks.preloadRoute }),
}));

vi.mock('@foresightjs/react', () => ({
  Foresight: ({
    as: Target,
    callback,
    enabled,
    linkProps,
  }: ForesightRegistration & {
    as: ComponentType<{ linkProps: LinkProps }>;
    linkProps: LinkProps;
  }) => {
    mocks.register({ callback, enabled });
    return <Target linkProps={linkProps} />;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

it.each([
  { scenario: 'without an explicit preload', props: {} },
  { scenario: 'with intent preload', props: { preload: 'intent' as const } },
])('disables protected navigation and preloading $scenario', ({ props }) => {
  expect(process.env.NODE_ENV).toBe('production');
  expect(import.meta.env.PROD).toBe(true);

  const markup = renderToStaticMarkup(
    <BridgeLink to="/logout" {...props}>
      Logout
    </BridgeLink>
  );

  expect(markup).toBe('Logout');
  expect(mocks.links).toHaveBeenCalledOnce();
  expect(mocks.links.mock.calls[0]?.[0]).toMatchObject({
    to: '/logout',
    disabled: true,
    preload: false,
  });
  expect(mocks.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ enabled: false })
  );
  const registration = mocks.register.mock.calls[0]?.[0];
  assert(registration);
  registration.callback();
  expect(mocks.preloadRoute).not.toHaveBeenCalled();
});

it('renders an inert anchor with TanStack for an unsupported external destination', async () => {
  expect(import.meta.env.PROD).toBe(true);
  const {
    createMemoryHistory,
    createRootRoute,
    createRouter,
    Link,
    RouterContextProvider,
  } = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router'
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: createRootRoute(),
    defaultPreload: 'intent',
  });
  await router.load();
  mocks.links.mockImplementationOnce((props) =>
    createElement(Link, props as never)
  );
  const markup = renderToStaticMarkup(
    <RouterContextProvider router={router}>
      {/* @ts-expect-error Simulate an untyped caller passing href. */}
      <BridgeLink to="https://example.test/" href="/manager">
        Link
      </BridgeLink>
    </RouterContextProvider>
  );

  expect(markup).toContain('aria-disabled="true"');
  expect(markup).not.toContain(' href=');
});

it.each([
  { options: { href: '/manager' }, to: '/login' as const },
  { options: { unsafeRelative: 'path' as const }, to: '/login' as const },
  { options: { href: '/manager' }, to: 'https://example.test/' as const },
])('neutralizes unsupported destinations in production', ({ options, to }) => {
  expect(import.meta.env.PROD).toBe(true);
  const untypedProps = { ...options, to, preload: 'intent', children: 'Link' };
  renderToStaticMarkup(createElement(BridgeLink, untypedProps as never));

  expect(mocks.links).toHaveBeenCalledOnce();
  expect(mocks.links.mock.calls[0]?.[0]).toMatchObject({
    to: undefined,
    href: undefined,
    unsafeRelative: undefined,
    disabled: true,
    preload: false,
  });
  const registration = mocks.register.mock.calls[0]?.[0];
  assert(registration);
  expect(registration.enabled).toBe(false);
  registration.callback();
  expect(mocks.preloadRoute).not.toHaveBeenCalled();
});
