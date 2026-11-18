import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createContext, type ReactNode, useContext, useState } from 'react';

const FixtureChildren = createContext<ReactNode>(null);

export function ButtonLinkRouteChildren() {
  return useContext(FixtureChildren);
}

export function ButtonLinkRouterProvider({
  router,
  children,
}: {
  router: AnyRouter;
  children: ReactNode;
}) {
  return (
    <FixtureChildren value={children}>
      <RouterProvider router={router} />
    </FixtureChildren>
  );
}

export function ButtonLinkFixtureRouter({ children }: { children: ReactNode }) {
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({ component: ButtonLinkRouteChildren }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
  );

  return (
    <ButtonLinkRouterProvider router={router}>
      {children}
    </ButtonLinkRouterProvider>
  );
}
