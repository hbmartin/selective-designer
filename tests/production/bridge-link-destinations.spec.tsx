import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { BridgeLink } from '@/platform/router';

it('renders safe implicit relative and masked destinations in production', async () => {
  expect(process.env.NODE_ENV).toBe('production');
  expect(import.meta.env.PROD).toBe(true);
  const root = createRootRoute();
  const routes = ['/app', '/login', '/manager'].map((path) =>
    createRoute({ getParentRoute: () => root, path })
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/app'] }),
    routeTree: root.addChildren(routes),
  });
  await router.load();

  const markup = renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <BridgeLink to="..">Parent</BridgeLink>
      <BridgeLink
        to="/manager"
        hash="internal"
        mask={{ to: '/login', hash: 'public', unmaskOnReload: true }}
      >
        Masked
      </BridgeLink>
    </RouterContextProvider>
  );

  expect(markup).toContain('href="/">Parent');
  expect(markup).toContain('href="/login#public">Masked');
  expect(markup).not.toContain('aria-disabled');
});
