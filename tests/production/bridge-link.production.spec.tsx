import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

import { BridgeLink } from '@/platform/router';

const mocks = vi.hoisted(() => ({
  foresight: vi.fn(),
}));

vi.mock('@foresightjs/react', () => ({
  Foresight: mocks.foresight,
}));

const root = createRootRoute();
const routes = ['/app', '/login', '/logout'].map((path) =>
  createRoute({ getParentRoute: () => root, path })
);
const router = createRouter({
  history: createMemoryHistory({ initialEntries: ['/app'] }),
  routeTree: root.addChildren(routes),
  defaultPreload: 'intent',
});

beforeEach(async () => {
  expect(process.env.NODE_ENV).toBe('production');
  expect(import.meta.env.PROD).toBe(true);
  vi.clearAllMocks();
  await router.load();
});

it.each([
  { to: '/logout' },
  { to: '/logout', preload: 'intent' },
  { to: '/logout', mask: { to: '/login' } },
  { to: '/login', mask: { to: '/logout' } },
  { to: '../logout' },
  { to: '/LOGOUT' },
  { to: '/%6Cogout' },
  { to: '/app/../logout' },
  { to: '/app', href: '/login' },
  { to: '/login', unsafeRelative: 'path' },
  { to: 'https://example.test/', href: '/app' },
])('renders an inactive, inert anchor for %j', (props) => {
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
