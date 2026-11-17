import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BridgeLink } from '@/platform/router';

const mocks = vi.hoisted(() => ({
  foresight: vi.fn(),
}));

vi.mock('@foresightjs/react', () => ({
  Foresight: mocks.foresight,
}));

beforeEach(() => {
  expect(process.env.NODE_ENV).toBe('production');
  expect(import.meta.env.PROD).toBe(true);
  vi.clearAllMocks();
});

const indexDestinations = [
  { to: '/logout' },
  { to: '/logout/' },
  { to: '/logout', preload: 'intent' },
  { to: '/logout', mask: { to: '/login' } },
  { to: '/login', mask: { to: '/logout' } },
  { to: '/login', mask: { to: '/logout/' } },
  { to: '../logout' },
  { to: '/LOGOUT' },
  { to: '/%6Cogout' },
  { to: '/app/../logout' },
  { to: '/app', href: '/login' },
  { to: '/login', unsafeRelative: 'path' },
  { to: 'https://example.test/', href: '/app' },
];

describe.each([
  {
    shape: 'leaf route',
    child: undefined,
    destinations: [
      { to: '/logout', preload: 'intent' },
      { to: '/login', mask: { to: '/logout' } },
    ],
  },
  { shape: 'index route', child: '/', destinations: indexDestinations },
  {
    shape: 'ancestor route',
    child: 'child',
    destinations: [
      { to: '/logout/child', preload: 'intent' },
      { to: '/login', mask: { to: '/logout/child' } },
    ],
  },
])('BridgeLink with a protected $shape', ({ child, destinations }) => {
  const root = createRootRoute();
  const routes = ['/app', '/login'].map((path) =>
    createRoute({ getParentRoute: () => root, path })
  );
  const logout = createRoute({ getParentRoute: () => root, path: 'logout' });
  if (child !== undefined) {
    logout.addChildren([
      createRoute({ getParentRoute: () => logout, path: child }),
    ]);
  }
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/app'] }),
    routeTree: root.addChildren([...routes, logout]),
    defaultPreload: 'intent',
  });
  beforeEach(() => router.load());

  it.each(destinations)('renders an inactive, inert anchor for %j', (props) => {
    const preload = vi.spyOn(router, 'preloadRoute');
    try {
      const markup = renderToStaticMarkup(
        <RouterContextProvider router={router}>
          {createElement(BridgeLink, {
            ...props,
            children: ({ isActive }: { isActive: boolean }) =>
              isActive ? 'Active' : 'Inactive',
            'aria-current': 'page',
            'data-status': 'active',
            className: 'link',
          } as never)}
        </RouterContextProvider>
      );

      expect(markup).toContain('aria-disabled="true"');
      expect(markup).toContain('class="link"');
      expect(markup).toContain('>Inactive</a>');
      expect(markup).not.toMatch(/ (href|aria-current|data-status)=/);
      expect(mocks.foresight).not.toHaveBeenCalled();
      expect(preload).not.toHaveBeenCalled();
    } finally {
      preload.mockRestore();
    }
  });
});
